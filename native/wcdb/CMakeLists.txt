cmake_minimum_required(VERSION 3.20)
project(omp_wcdb_bridge VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)

set(WCDB_ROOT "" CACHE PATH "Pinned WCDB source root")
set(WCDB_BUILD "" CACHE PATH "Pinned WCDB CMake build root")
if(NOT WCDB_ROOT OR NOT WCDB_BUILD)
    message(FATAL_ERROR "WCDB_ROOT and WCDB_BUILD must identify the verified pinned source/build")
endif()

set(WCDB_INCLUDE "${WCDB_BUILD}/export_headers/WCDB")
set(WCDB_BRIDGE_BASE "${WCDB_ROOT}/src/bridge/base")
set(WCDB_BRIDGE_CPP "${WCDB_ROOT}/src/bridge/cppbridge")
set(WCDB_BRIDGE_WINQ "${WCDB_ROOT}/src/bridge/winqbridge")
set(WCDB_LIBRARY "${WCDB_BUILD}/libWCDB.a")
set(WCDB_SQLCIPHER_LIBRARY "${WCDB_BUILD}/libsqlcipher.a")
set(WCDB_ZSTD_LIBRARY "${WCDB_BUILD}/libzstd.a")
set(WCDB_CRYPTO_LIBRARY "${WCDB_ROOT}/tools/prebuild/openssl/linux/x86_64/libcrypto.a")
set(WCDB_ZLIB_LIBRARY "${WCDB_ROOT}/tools/prebuild/zlib/linux/x86_64/libz.a")
foreach(required_library
        "${WCDB_LIBRARY}"
        "${WCDB_SQLCIPHER_LIBRARY}"
        "${WCDB_ZSTD_LIBRARY}"
        "${WCDB_CRYPTO_LIBRARY}"
        "${WCDB_ZLIB_LIBRARY}")
    if(NOT EXISTS "${required_library}")
        message(FATAL_ERROR "Pinned WCDB static dependency missing: ${required_library}")
    endif()
endforeach()
foreach(required_header WCDBCpp.h StringView.hpp UnsafeData.hpp)
    if(NOT EXISTS "${WCDB_INCLUDE}/${required_header}")
        message(FATAL_ERROR "Pinned WCDB export header missing: ${WCDB_INCLUDE}/${required_header}")
    endif()
endforeach()
foreach(required_bridge_header CoreBridge.h DatabaseBridge.h HandleBridge.h HandleStatementBridge.h)
    if(NOT EXISTS "${WCDB_BRIDGE_CPP}/${required_bridge_header}")
        message(FATAL_ERROR "Pinned WCDB bridge header missing: ${WCDB_BRIDGE_CPP}/${required_bridge_header}")
    endif()
endforeach()

add_library(omp_wcdb_bridge SHARED src/omp_wcdb.cpp)
target_include_directories(omp_wcdb_bridge
    PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include"
    PRIVATE
        "${WCDB_INCLUDE}"
        "${WCDB_BRIDGE_BASE}"
        "${WCDB_BRIDGE_CPP}"
        "${WCDB_BRIDGE_WINQ}"
)
target_link_libraries(omp_wcdb_bridge PRIVATE
    "${WCDB_LIBRARY}"
    "${WCDB_SQLCIPHER_LIBRARY}"
    "${WCDB_ZSTD_LIBRARY}"
    "${WCDB_CRYPTO_LIBRARY}"
    "${WCDB_ZLIB_LIBRARY}"
    pthread
    dl
)
target_compile_options(omp_wcdb_bridge PRIVATE -Wall -Wextra -Wpedantic -Werror=return-type)
set_target_properties(omp_wcdb_bridge PROPERTIES
    OUTPUT_NAME omp_wcdb_bridge
    BUILD_RPATH "$ORIGIN"
    INSTALL_RPATH "$ORIGIN"
)

install(TARGETS omp_wcdb_bridge LIBRARY DESTINATION lib)
 
install(FILES include/omp_wcdb.h DESTINATION include)
