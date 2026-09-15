#include "omp_wcdb.h"

#if !defined(__clang__)
#define _Nonnull
#define _Nullable
#endif

#include "CoreBridge.h"
#include "DatabaseBridge.h"
#include "ErrorBridge.h"
#include "HandleBridge.h"
#include "HandleStatementBridge.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <limits>
#include <mutex>
#include <new>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

struct omp_wcdb_handle {
    CPPDatabase database{};
    std::mutex operationMutex;
    std::mutex stateMutex;
    bool closing = false;
    std::string lastError;
    std::unordered_map<uint64_t, CPPCancellationSignal> cancellations;
    std::unordered_set<uint64_t> cancelledTokens;
};

namespace {
constexpr uint32_t kAbiVersion = 1;
constexpr uint32_t kRequestMagic = 0x5152574f;  // OWRQ, little endian
constexpr uint32_t kResponseMagic = 0x5352574f; // OWRS, little endian
constexpr uint16_t kProtocolVersion = 1;
constexpr uint16_t kBatchTransactional = 1;
constexpr uint8_t kExecute = 1;
constexpr uint8_t kQuery = 2;
constexpr uint8_t kNull = 0;
constexpr uint8_t kInteger = 1;
constexpr uint8_t kFloat = 2;
constexpr uint8_t kText = 3;
constexpr uint8_t kBlob = 4;
constexpr uint32_t kMaxStatements = 4096;
constexpr uint32_t kMaxParameters = 65535;
constexpr uint32_t kMaxColumns = 4096;
constexpr uint64_t kMaxFrameBytes = 256ULL * 1024ULL * 1024ULL;

struct Reader {
    const uint8_t *cursor;
    const uint8_t *end;

    bool take(void *destination, size_t length)
    {
        if (length > static_cast<size_t>(end - cursor)) return false;
        std::memcpy(destination, cursor, length);
        cursor += length;
        return true;
    }

    template <typename T> bool little(T &value)
    {
        static_assert(std::is_integral_v<T> || std::is_floating_point_v<T>);
        uint8_t bytes[sizeof(T)];
        if (!take(bytes, sizeof(bytes))) return false;
        if constexpr (std::is_floating_point_v<T>) {
            using Bits = std::conditional_t<sizeof(T) == 8, uint64_t, uint32_t>;
            Bits bits = 0;
            for (size_t index = 0; index < sizeof(T); ++index) {
                bits |= static_cast<Bits>(bytes[index]) << (index * 8);
            }
            std::memcpy(&value, &bits, sizeof(value));
        } else {
            using Unsigned = std::make_unsigned_t<T>;
            Unsigned result = 0;
            for (size_t index = 0; index < sizeof(T); ++index) {
                result |= static_cast<Unsigned>(bytes[index]) << (index * 8);
            }
            value = static_cast<T>(result);
        }
        return true;
    }
};

struct Writer {
    std::vector<uint8_t> bytes;

    template <typename T> bool little(T value)
    {
        if (bytes.size() > kMaxFrameBytes - sizeof(T)) return false;
        if constexpr (std::is_floating_point_v<T>) {
            using Bits = std::conditional_t<sizeof(T) == 8, uint64_t, uint32_t>;
            Bits bits = 0;
            std::memcpy(&bits, &value, sizeof(value));
            return little(bits);
        } else {
            using Unsigned = std::make_unsigned_t<T>;
            const auto unsignedValue = static_cast<Unsigned>(value);
            for (size_t index = 0; index < sizeof(T); ++index) {
                bytes.push_back(static_cast<uint8_t>(unsignedValue >> (index * 8)));
            }
            return true;
        }
    }

    bool append(const void *source, size_t length)
    {
        if (length == 0) return true;
        if (source == nullptr) return false;
        if (length > kMaxFrameBytes || bytes.size() > kMaxFrameBytes - length) return false;
        const auto *begin = static_cast<const uint8_t *>(source);
        bytes.insert(bytes.end(), begin, begin + length);
        return true;
    }

    bool sized(const void *source, size_t length)
    {
        if (length > std::numeric_limits<uint32_t>::max()) return false;
        return little(static_cast<uint32_t>(length)) && append(source, length);
    }
};


void releaseObject(CPPObject *object)
{
    if (object != nullptr) WCDBReleaseCPPObject(object);
}

void setError(omp_wcdb_handle *handle, std::string message)
{
    if (handle == nullptr) return;
    std::lock_guard lock(handle->stateMutex);
    handle->lastError = std::move(message);
}

std::string engineError(CPPHandle handle)
{
    CPPError error = WCDBHandleGetError(handle);
    const char *message = WCDBErrorGetMsg(error);
    return message != nullptr && *message != '\0' ? message : "WCDB operation failed";
}

int64_t readBusyTimeout(CPPHandle handle)
{
    CPPHandleStatement statement = WCDBHandlePrepareNewStatementSQL(handle, "PRAGMA busy_timeout");
    if (statement.innerValue == nullptr) return -1;
    int64_t timeout = -1;
    if (WCDBHandleStatementStep(statement) && !WCDBHandleStatementIsDone(statement)) {
        timeout = WCDBHandleStatementGetInteger(statement, 0);
    }
    WCDBHandleFinalizeAndReturnPreparedStatement(handle, statement);
    return timeout;
}

bool setBusyTimeout(CPPHandle handle, uint32_t timeoutMs)
{
    const std::string sql = "PRAGMA busy_timeout=" + std::to_string(timeoutMs);
    return WCDBHandleExecuteSQL(handle, sql.c_str());
}


bool readSized(Reader &reader, const uint8_t *&data, uint32_t &length)
{
    if (!reader.little(length) || length > static_cast<uint32_t>(reader.end - reader.cursor)) return false;
    data = reader.cursor;
    reader.cursor += length;
    return true;
}

bool bindParameters(Reader &reader, CPPHandleStatement statement, uint32_t parameterCount)
{
    if (statement.innerValue == nullptr || parameterCount > kMaxParameters) return false;
    for (uint32_t parameter = 0; parameter < parameterCount; ++parameter) {
        uint8_t type = 0;
        if (!reader.little(type)) return false;
        const int index = static_cast<int>(parameter + 1);
        switch (type) {
        case kNull:
            WCDBHandleStatementBindNull(statement, index);
            break;
        case kInteger: {
            int64_t value = 0;
            if (!reader.little(value)) return false;
            WCDBHandleStatementBindInteger(statement, index, value);
            break;
        }
        case kFloat: {
            double value = 0;
            if (!reader.little(value)) return false;
            WCDBHandleStatementBindDouble(statement, index, value);
            break;
        }
        case kText: {
            const uint8_t *data = nullptr;
            uint32_t length = 0;
            if (!readSized(reader, data, length)
                || std::memchr(data, '\0', length) != nullptr) return false;
            const std::string text(reinterpret_cast<const char *>(data), length);
            WCDBHandleStatementBindText(statement, index, text.c_str());
            break;
        }
        case kBlob: {
            const uint8_t *data = nullptr;
            uint32_t length = 0;
            if (!readSized(reader, data, length)) return false;
            WCDBHandleStatementBindBlob(statement, index, data, length);
            break;
        }
        default:
            return false;
        }
    }
    return true;
}

bool writeCell(Writer &writer, CPPHandleStatement bridged, int column)
{
    switch (WCDBHandleStatementGetColumnType(bridged, column)) {
    case WCDBColumnValueTypeInterger:
        return writer.little(kInteger)
            && writer.little(static_cast<int64_t>(WCDBHandleStatementGetInteger(bridged, column)));
    case WCDBColumnValueTypeFloat:
        return writer.little(kFloat)
            && writer.little(WCDBHandleStatementGetDouble(bridged, column));
    case WCDBColumnValueTypeString: {
        const char *text = WCDBHandleStatementGetText(bridged, column);
        const auto size = WCDBHandleStatementGetColumnSize(bridged, column);
        return size >= 0 && writer.little(kText)
            && writer.sized(text == nullptr ? "" : text, static_cast<size_t>(size));
    }
    case WCDBColumnValueTypeBLOB: {
        const uint8_t *blob = WCDBHandleStatementGetBlob(bridged, column);
        const auto size = WCDBHandleStatementGetColumnSize(bridged, column);
        return size >= 0 && writer.little(kBlob)
            && writer.sized(blob, static_cast<size_t>(size));
    }
    case WCDBColumnValueTypeNull:
        return writer.little(kNull);
    default:
        return false;
    }
}

omp_wcdb_status copyResponse(Writer &writer, omp_wcdb_buffer *output)
{
    if (writer.bytes.empty()) return OMP_WCDB_INTERNAL_ERROR;
    auto *data = static_cast<uint8_t *>(std::malloc(writer.bytes.size()));
    if (data == nullptr) return OMP_WCDB_OUT_OF_MEMORY;
    std::memcpy(data, writer.bytes.data(), writer.bytes.size());
    output->data = data;
    output->length = writer.bytes.size();
    return OMP_WCDB_OK;
}

omp_wcdb_status runBatch(omp_wcdb_handle *handle,
                          Reader &reader,
                          uint16_t flags,
                          uint32_t statementCount,
                          uint32_t timeoutMs,
                          CPPHandle wcdbHandle,
                          omp_wcdb_buffer *output)
{
    const bool transactional = (flags & kBatchTransactional) != 0;
    Writer writer;
    writer.bytes.reserve(std::min<uint64_t>(kMaxFrameBytes, static_cast<uint64_t>(reader.end - reader.cursor) + 64));
    if (!writer.little(kResponseMagic) || !writer.little(kProtocolVersion)
        || !writer.little(static_cast<uint16_t>(OMP_WCDB_OK)) || !writer.little(statementCount)) {
        return OMP_WCDB_OUT_OF_MEMORY;
    }
    if (transactional && !WCDBHandleBeginTransaction(wcdbHandle)) {
        setError(handle, engineError(wcdbHandle));
        return OMP_WCDB_ENGINE_ERROR;
    }
    bool committed = false;
    auto rollback = [&]() {
        if (transactional && !committed) WCDBHandleRollbackTransaction(wcdbHandle);
    };

    for (uint32_t statementIndex = 0; statementIndex < statementCount; ++statementIndex) {
        uint8_t opcode = 0;
        uint8_t reserved = 0;
        uint16_t reserved2 = 0;
        uint32_t maxRows = 0;
        uint32_t parameterCount = 0;
        const uint8_t *sqlBytes = nullptr;
        uint32_t sqlLength = 0;
        if (!reader.little(opcode) || !reader.little(reserved) || !reader.little(reserved2)
            || !reader.little(maxRows) || !readSized(reader, sqlBytes, sqlLength)
            || !reader.little(parameterCount) || sqlLength == 0
            || std::memchr(sqlBytes, '\0', sqlLength) != nullptr
            || reserved != 0 || reserved2 != 0 || (opcode != kExecute && opcode != kQuery)
            || (opcode == kQuery && maxRows == 0)) {
            rollback();
            setError(handle, "invalid batch statement frame");
            return OMP_WCDB_PROTOCOL_ERROR;
        }
        std::string sql(reinterpret_cast<const char *>(sqlBytes), sqlLength);
        CPPHandleStatement statement = WCDBHandlePrepareNewStatementSQL(wcdbHandle, sql.c_str());
        if (statement.innerValue == nullptr) {
            rollback();
            setError(handle, engineError(wcdbHandle));
            return OMP_WCDB_ENGINE_ERROR;
        }
        auto finalize = [&]() { WCDBHandleFinalizeAndReturnPreparedStatement(wcdbHandle, statement); };
        if (!bindParameters(reader, statement, parameterCount)) {
            finalize();
            rollback();
            setError(handle, "invalid batch parameter frame");
            return OMP_WCDB_PROTOCOL_ERROR;
        }
        // WCDB reapplies its built-in ten-second busy handler while preparing a
        // statement. Install the caller's tighter deadline after preparation so
        // sqlite3_step observes the native ABI timeout rather than that default.
        if (timeoutMs != 0 && timeoutMs < 10000 && !setBusyTimeout(wcdbHandle, timeoutMs)) {
            finalize();
            rollback();
            setError(handle, engineError(wcdbHandle));
            return OMP_WCDB_ENGINE_ERROR;
        }

        const int columnCount = opcode == kQuery ? WCDBHandleStatementGetColumnCount(statement) : 0;
        if (columnCount < 0 || static_cast<uint32_t>(columnCount) > kMaxColumns
            || !writer.little(static_cast<int64_t>(0)) || !writer.little(static_cast<int64_t>(0))
            || !writer.little(static_cast<uint32_t>(columnCount))) {
            finalize();
            rollback();
            setError(handle, "response exceeds protocol limits");
            return OMP_WCDB_PROTOCOL_ERROR;
        }
        for (int column = 0; column < columnCount; ++column) {
            const char *name = WCDBHandleStatementGetColumnName(statement, column);
            if (!writer.sized(name == nullptr ? "" : name, name == nullptr ? 0 : std::strlen(name))) {
                finalize();
                rollback();
                return OMP_WCDB_OUT_OF_MEMORY;
            }
        }
        const size_t rowCountOffset = writer.bytes.size();
        if (!writer.little(static_cast<uint32_t>(0))) {
            finalize();
            rollback();
            return OMP_WCDB_OUT_OF_MEMORY;
        }
        uint32_t rowCount = 0;
        while (true) {
            if (!WCDBHandleStatementStep(statement)) {
                finalize();
                rollback();
                setError(handle, engineError(wcdbHandle));
                return OMP_WCDB_ENGINE_ERROR;
            }
            if (WCDBHandleStatementIsDone(statement)) break;
            if (opcode != kQuery || rowCount == maxRows) {
                finalize();
                rollback();
                setError(handle, "query exceeded maxRows");
                return OMP_WCDB_PROTOCOL_ERROR;
            }
            for (int column = 0; column < columnCount; ++column) {
                if (!writeCell(writer, statement, column)) {
                    finalize();
                    rollback();
                    setError(handle, "response cell exceeds protocol limits");
                    return OMP_WCDB_PROTOCOL_ERROR;
                }
            }
            ++rowCount;
        }
        finalize();
        for (size_t byte = 0; byte < sizeof(rowCount); ++byte) {
            writer.bytes[rowCountOffset + byte] = static_cast<uint8_t>(rowCount >> (byte * 8));
        }
        // Affected-row/last-insert values are intentionally reserved as int64 fields in v1.
        // The repository contract must not infer durable success from either value; commit is the acknowledgement.
    }
    if (reader.cursor != reader.end) {
        rollback();
        setError(handle, "trailing bytes in batch request");
        return OMP_WCDB_PROTOCOL_ERROR;
    }
    if (transactional && !WCDBHandleCommitTransaction(wcdbHandle)) {
        rollback();
        setError(handle, engineError(wcdbHandle));
        return OMP_WCDB_ENGINE_ERROR;
    }
    committed = true;
    return copyResponse(writer, output);
}

class SignalRegistration {
public:
    SignalRegistration(omp_wcdb_handle *handle, CPPHandle wcdbHandle, uint64_t token)
        : m_handle(handle), m_wcdbHandle(wcdbHandle), m_token(token), m_signal(WCDBCancellationSignalCreate())
    {
    }

    bool attach()
    {
        if (m_signal.innerValue == nullptr) return false;
        if (m_token != 0) {
            std::lock_guard lock(m_handle->stateMutex);
            if (m_handle->closing || m_handle->cancellations.contains(m_token)) return false;
            m_handle->cancellations.emplace(m_token, m_signal);
        }
        WCDBHandleAttachCancellationSignal(m_wcdbHandle, m_signal);
        m_attached = true;
        return true;
    }

    ~SignalRegistration() { finish(); }

    void finish()
    {
        if (m_attached) {
            WCDBHandleDettachCancellationSignal(m_wcdbHandle);
            m_attached = false;
        }
        if (m_token != 0) {
            std::lock_guard lock(m_handle->stateMutex);
            m_handle->cancellations.erase(m_token);
        }
        releaseObject(m_signal.innerValue);
        m_signal.innerValue = nullptr;
    }

    CPPCancellationSignal signal() const { return m_signal; }

private:
    omp_wcdb_handle *m_handle;
    CPPHandle m_wcdbHandle;
    uint64_t m_token;
    CPPCancellationSignal m_signal{};
    bool m_attached = false;
};

} // namespace

extern "C" {

uint32_t omp_wcdb_abi_version(void) { return kAbiVersion; }

const char *omp_wcdb_build_id(void)
{
    return "omp-wcdb-bridge/1;wcdb/2.1.16;sqlite/3.27.2;protocol/1";
}

omp_wcdb_status omp_wcdb_open(const uint8_t *path,
                               uint64_t pathLength,
                               uint32_t flags,
                               omp_wcdb_handle **outHandle)
{
    try {
        if (path == nullptr || pathLength == 0 || pathLength > 32768 || outHandle == nullptr
            || (flags & ~(OMP_WCDB_OPEN_READONLY | OMP_WCDB_OPEN_CREATE)) != 0) {
            return OMP_WCDB_INVALID_ARGUMENT;
        }
        *outHandle = nullptr;
        std::string databasePath(reinterpret_cast<const char *>(path), static_cast<size_t>(pathLength));
        if (databasePath.find('\0') != std::string::npos) return OMP_WCDB_INVALID_ARGUMENT;
        const bool readonly = (flags & OMP_WCDB_OPEN_READONLY) != 0;
        if (!readonly && (flags & OMP_WCDB_OPEN_CREATE) == 0 && !std::filesystem::exists(databasePath)) {
            return OMP_WCDB_INVALID_ARGUMENT;
        }
        auto *handle = new (std::nothrow) omp_wcdb_handle();
        if (handle == nullptr) return OMP_WCDB_OUT_OF_MEMORY;
        handle->database = WCDBCoreCreateDatabase(databasePath.c_str(), readonly, false);
        if (handle->database.innerValue == nullptr || !WCDBDatabaseCanOpen(handle->database)) {
            CPPError error = WCDBDatabaseGetError(handle->database);
            const char *message = WCDBErrorGetMsg(error);
            handle->lastError = message != nullptr ? message : "WCDB could not open database";
            releaseObject(handle->database.innerValue);
            delete handle;
            return OMP_WCDB_ENGINE_ERROR;
        }
        *outHandle = handle;
        return OMP_WCDB_OK;
    } catch (const std::bad_alloc &) {
        return OMP_WCDB_OUT_OF_MEMORY;
    } catch (...) {
        return OMP_WCDB_INTERNAL_ERROR;
    }
}

omp_wcdb_status omp_wcdb_batch(omp_wcdb_handle *handle,
                                const uint8_t *request,
                                uint64_t requestLength,
                                uint32_t timeoutMs,
                                uint64_t cancellationToken,
                                omp_wcdb_buffer *outResponse)
{
    try {
        if (handle == nullptr || request == nullptr || outResponse == nullptr || requestLength < 12
            || requestLength > kMaxFrameBytes) {
            return OMP_WCDB_INVALID_ARGUMENT;
        }
        outResponse->data = nullptr;
        outResponse->length = 0;
        std::unique_lock operationLock(handle->operationMutex);
        {
            std::lock_guard stateLock(handle->stateMutex);
            if (handle->closing) return OMP_WCDB_CLOSED;
            handle->lastError.clear();
        }
        CPPHandle wcdbHandle = WCDBDatabaseGetHandle(handle->database, true);
        if (wcdbHandle.innerValue == nullptr) {
            setError(handle, "WCDB did not provide a handle");
            return OMP_WCDB_ENGINE_ERROR;
        }
        const int64_t originalBusyTimeout = timeoutMs == 0 ? -1 : readBusyTimeout(wcdbHandle);
        const bool busyTimeoutCapped = timeoutMs != 0 && timeoutMs < 10000;
        if (busyTimeoutCapped && !setBusyTimeout(wcdbHandle, timeoutMs)) {
            setError(handle, engineError(wcdbHandle));
            releaseObject(wcdbHandle.innerValue);
            return OMP_WCDB_ENGINE_ERROR;
        }
        SignalRegistration registration(handle, wcdbHandle, cancellationToken);
        if (!registration.attach()) {
            releaseObject(wcdbHandle.innerValue);
            setError(handle, "duplicate cancellation token or closing handle");
            return OMP_WCDB_BUSY;
        }

        std::mutex timerMutex;
        std::condition_variable timerCondition;
        bool finished = false;
        std::atomic<bool> timedOut = false;
        std::thread watchdog;
        if (timeoutMs != 0) {
            watchdog = std::thread([&, signal = registration.signal()] {
                std::unique_lock timerLock(timerMutex);
                if (!timerCondition.wait_for(timerLock, std::chrono::milliseconds(timeoutMs), [&] { return finished; })) {
                    timedOut.store(true, std::memory_order_release);
                    WCDBCancellationSignalCancel(signal);
                }
            });
        }

        Reader reader{ request, request + requestLength };
        uint32_t magic = 0;
        uint16_t version = 0;
        uint16_t flags = 0;
        uint32_t statementCount = 0;
        omp_wcdb_status status = OMP_WCDB_PROTOCOL_ERROR;
        if (reader.little(magic) && reader.little(version) && reader.little(flags)
            && reader.little(statementCount) && magic == kRequestMagic && version == kProtocolVersion
            && (flags & ~kBatchTransactional) == 0 && statementCount <= kMaxStatements) {
            status = runBatch(handle, reader, flags, statementCount, timeoutMs, wcdbHandle, outResponse);
        } else {
            setError(handle, "invalid batch header");
        }
        {
            std::lock_guard timerLock(timerMutex);
            finished = true;
        }
        timerCondition.notify_one();
        if (watchdog.joinable()) watchdog.join();
        if (busyTimeoutCapped) {
            setBusyTimeout(wcdbHandle, static_cast<uint32_t>(originalBusyTimeout));
        }
        bool externallyCancelled = false;
        if (cancellationToken != 0) {
            std::lock_guard stateLock(handle->stateMutex);
            externallyCancelled = handle->cancelledTokens.erase(cancellationToken) != 0;
        }
        registration.finish();
        releaseObject(wcdbHandle.innerValue);
        if (timedOut.load(std::memory_order_acquire)) {
            omp_wcdb_free_buffer(outResponse->data, outResponse->length);
            outResponse->data = nullptr;
            outResponse->length = 0;
            setError(handle, "WCDB batch deadline exceeded");
            return OMP_WCDB_TIMEOUT;
        }
        if (externallyCancelled) {
            omp_wcdb_free_buffer(outResponse->data, outResponse->length);
            outResponse->data = nullptr;
            outResponse->length = 0;
            setError(handle, "WCDB batch cancelled");
            return OMP_WCDB_CANCELLED;
        }
        return status;
    } catch (const std::bad_alloc &) {
        setError(handle, "out of memory");
        return OMP_WCDB_OUT_OF_MEMORY;
    } catch (const std::exception &error) {
        setError(handle, error.what());
        return OMP_WCDB_INTERNAL_ERROR;
    } catch (...) {
        setError(handle, "unknown native exception");
        return OMP_WCDB_INTERNAL_ERROR;
    }
}

omp_wcdb_status omp_wcdb_cancel(omp_wcdb_handle *handle, uint64_t cancellationToken)
{
    try {
        if (handle == nullptr || cancellationToken == 0) return OMP_WCDB_INVALID_ARGUMENT;
        std::lock_guard lock(handle->stateMutex);
        auto found = handle->cancellations.find(cancellationToken);
        if (found == handle->cancellations.end()) return OMP_WCDB_INVALID_ARGUMENT;
        WCDBCancellationSignalCancel(found->second);
        handle->cancelledTokens.insert(cancellationToken);
        return OMP_WCDB_OK;
    } catch (...) {
        return OMP_WCDB_INTERNAL_ERROR;
    }
}

omp_wcdb_status omp_wcdb_checkpoint(omp_wcdb_handle *handle, omp_wcdb_checkpoint_mode mode)
{
    try {
        if (handle == nullptr || (mode != OMP_WCDB_CHECKPOINT_PASSIVE && mode != OMP_WCDB_CHECKPOINT_TRUNCATE)) {
            return OMP_WCDB_INVALID_ARGUMENT;
        }
        std::lock_guard operationLock(handle->operationMutex);
        {
            std::lock_guard stateLock(handle->stateMutex);
            if (handle->closing) return OMP_WCDB_CLOSED;
        }
        const bool success = mode == OMP_WCDB_CHECKPOINT_PASSIVE
            ? WCDBDatabasePassiveCheckpoint(handle->database)
            : WCDBDatabaseTruncateCheckpoint(handle->database);
        if (!success) {
            CPPError error = WCDBDatabaseGetError(handle->database);
            setError(handle, WCDBErrorGetMsg(error));
            return OMP_WCDB_ENGINE_ERROR;
        }
        return OMP_WCDB_OK;
    } catch (...) {
        setError(handle, "native exception during checkpoint");
        return OMP_WCDB_INTERNAL_ERROR;
    }
}

omp_wcdb_status omp_wcdb_backup(omp_wcdb_handle *handle,
                                 const uint8_t *destination,
                                 uint64_t destinationLength)
{
    try {
        if (handle == nullptr || destination == nullptr || destinationLength == 0 || destinationLength > 32768) {
            return OMP_WCDB_INVALID_ARGUMENT;
        }
        std::string destinationPath(reinterpret_cast<const char *>(destination), static_cast<size_t>(destinationLength));
        if (destinationPath.find('\0') != std::string::npos) return OMP_WCDB_INVALID_ARGUMENT;
        std::lock_guard operationLock(handle->operationMutex);
        {
            std::lock_guard stateLock(handle->stateMutex);
            if (handle->closing) return OMP_WCDB_CLOSED;
        }
        if (!WCDBDatabaseTruncateCheckpoint(handle->database)) {
            setError(handle, "WCDB checkpoint before backup failed");
            return OMP_WCDB_ENGINE_ERROR;
        }
        const char *source = WCDBDatabaseGetPath(handle->database);
        if (source == nullptr || *source == '\0') {
            setError(handle, "WCDB returned an empty database path");
            return OMP_WCDB_ENGINE_ERROR;
        }
        const std::string sourcePath(source);
        WCDBDatabaseClose(handle->database, nullptr, nullptr);
        std::error_code copyError;
        std::filesystem::copy_file(sourcePath, destinationPath, std::filesystem::copy_options::none, copyError);
        const bool reopened = WCDBDatabaseCanOpen(handle->database);
        if (copyError) {
            setError(handle, copyError.message());
            return OMP_WCDB_IO_ERROR;
        }
        if (!reopened) {
            setError(handle, "WCDB failed to reopen after backup");
            return OMP_WCDB_ENGINE_ERROR;
        }
        return OMP_WCDB_OK;
    } catch (const std::exception &error) {
        setError(handle, error.what());
        return OMP_WCDB_INTERNAL_ERROR;
    } catch (...) {
        setError(handle, "unknown native exception during backup");
        return OMP_WCDB_INTERNAL_ERROR;
    }
}

omp_wcdb_status omp_wcdb_last_error(omp_wcdb_handle *handle, omp_wcdb_buffer *outError)
{
    try {
        if (handle == nullptr || outError == nullptr) return OMP_WCDB_INVALID_ARGUMENT;
        outError->data = nullptr;
        outError->length = 0;
        std::lock_guard lock(handle->stateMutex);
        if (handle->lastError.empty()) return OMP_WCDB_OK;
        auto *copy = static_cast<uint8_t *>(std::malloc(handle->lastError.size()));
        if (copy == nullptr) return OMP_WCDB_OUT_OF_MEMORY;
        std::memcpy(copy, handle->lastError.data(), handle->lastError.size());
        outError->data = copy;
        outError->length = handle->lastError.size();
        return OMP_WCDB_OK;
    } catch (...) {
        return OMP_WCDB_INTERNAL_ERROR;
    }
}

omp_wcdb_status omp_wcdb_shutdown(omp_wcdb_handle *handle, uint32_t timeoutMs)
{
    try {
        if (handle == nullptr) return OMP_WCDB_INVALID_ARGUMENT;
        {
            std::lock_guard stateLock(handle->stateMutex);
            handle->closing = true;
            for (const auto &[token, signal] : handle->cancellations) {
                (void) token;
                WCDBCancellationSignalCancel(signal);
            }
        }
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
        while (!handle->operationMutex.try_lock()) {
            if (timeoutMs == 0 || std::chrono::steady_clock::now() >= deadline) return OMP_WCDB_TIMEOUT;
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        std::unique_lock operationLock(handle->operationMutex, std::adopt_lock);
        WCDBDatabaseClose(handle->database, nullptr, nullptr);
        releaseObject(handle->database.innerValue);
        handle->database.innerValue = nullptr;
        operationLock.unlock();
        delete handle;
        return OMP_WCDB_OK;
    } catch (...) {
        return OMP_WCDB_INTERNAL_ERROR;
    }
}

void omp_wcdb_free_buffer(uint8_t *data, uint64_t length)
{
    (void) length;
    std::free(data);
}

} // extern "C"
