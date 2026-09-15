#ifndef OMP_WCDB_H
#define OMP_WCDB_H

#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32)
#define OMP_WCDB_EXPORT __declspec(dllexport)
#else
#define OMP_WCDB_EXPORT __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct omp_wcdb_handle omp_wcdb_handle;

typedef struct omp_wcdb_buffer {
    uint8_t *data;
    uint64_t length;
} omp_wcdb_buffer;

typedef enum omp_wcdb_status {
    OMP_WCDB_OK = 0,
    OMP_WCDB_INVALID_ARGUMENT = 1,
    OMP_WCDB_OUT_OF_MEMORY = 2,
    OMP_WCDB_CLOSED = 3,
    OMP_WCDB_CANCELLED = 4,
    OMP_WCDB_TIMEOUT = 5,
    OMP_WCDB_ENGINE_ERROR = 6,
    OMP_WCDB_PROTOCOL_ERROR = 7,
    OMP_WCDB_BUSY = 8,
    OMP_WCDB_IO_ERROR = 9,
    OMP_WCDB_INTERNAL_ERROR = 10,
    OMP_WCDB_UNSUPPORTED = 11
} omp_wcdb_status;

typedef enum omp_wcdb_open_flag {
    OMP_WCDB_OPEN_READONLY = 1u << 0,
    OMP_WCDB_OPEN_CREATE = 1u << 1
} omp_wcdb_open_flag;

typedef enum omp_wcdb_checkpoint_mode {
    OMP_WCDB_CHECKPOINT_PASSIVE = 0,
    OMP_WCDB_CHECKPOINT_TRUNCATE = 1
} omp_wcdb_checkpoint_mode;

/* ABI v1 uses UTF-8 paths and little-endian batch frames documented in protocol.ts. */
OMP_WCDB_EXPORT uint32_t omp_wcdb_abi_version(void);
OMP_WCDB_EXPORT const char *omp_wcdb_build_id(void);
OMP_WCDB_EXPORT omp_wcdb_status omp_wcdb_open(const uint8_t *path,
                                               uint64_t path_length,
                                               uint32_t flags,
                                               omp_wcdb_handle **out_handle);
OMP_WCDB_EXPORT omp_wcdb_status omp_wcdb_batch(omp_wcdb_handle *handle,
                                                const uint8_t *request,
                                                uint64_t request_length,
                                                uint32_t timeout_ms,
                                                uint64_t cancellation_token,
                                                omp_wcdb_buffer *out_response);
OMP_WCDB_EXPORT omp_wcdb_status omp_wcdb_cancel(omp_wcdb_handle *handle,
                                                 uint64_t cancellation_token);
OMP_WCDB_EXPORT omp_wcdb_status omp_wcdb_checkpoint(omp_wcdb_handle *handle,
                                                     omp_wcdb_checkpoint_mode mode);
OMP_WCDB_EXPORT omp_wcdb_status omp_wcdb_backup(omp_wcdb_handle *handle,
                                                 const uint8_t *destination,
                                                 uint64_t destination_length);
OMP_WCDB_EXPORT omp_wcdb_status omp_wcdb_last_error(omp_wcdb_handle *handle,
                                                     omp_wcdb_buffer *out_error);
OMP_WCDB_EXPORT omp_wcdb_status omp_wcdb_shutdown(omp_wcdb_handle *handle,
                                                   uint32_t timeout_ms);
OMP_WCDB_EXPORT void omp_wcdb_free_buffer(uint8_t *data, uint64_t length);

#ifdef __cplusplus
}
#endif

#endif
