//! Windows 7 compatibility shims.
//!
//! The MSVC C runtime registers an ETW provider for telemetry, importing
//! `EventRegister` / `EventSetInformation` / `EventWriteTransfer` /
//! `EventUnregister` from `advapi32.dll`. `EventSetInformation` only exists on
//! Windows 8+, so the binary fails to load on Win7 with:
//!
//!   "The procedure entry point EventSetInformation could not be located in the
//!    dynamic link library ADVAPI32.dll"
//!
//! The `x86_64-win7-windows-msvc` target + `build-std` fix Rust `std`'s API usage,
//! but not the MSVC CRT (which `build-std` does not rebuild). We neutralize the CRT
//! telemetry by defining each function AND the `__imp_*` pointer the CRT calls
//! through; object symbols win over import libraries, so the linker resolves these
//! locally and emits no advapi32 import for them. The stubs are no-ops returning
//! ERROR_SUCCESS (0) — the CRT just thinks telemetry registered and writes nothing.
#![allow(non_snake_case, non_upper_case_globals)]

use core::ffi::c_void;

#[no_mangle]
unsafe extern "system" fn EventRegister(
    _provider_id: *const c_void,
    _callback: *const c_void,
    _context: *const c_void,
    reg_handle: *mut u64,
) -> u32 {
    if !reg_handle.is_null() {
        unsafe { *reg_handle = 0 };
    }
    0
}

#[no_mangle]
unsafe extern "system" fn EventUnregister(_reg_handle: u64) -> u32 {
    0
}

#[no_mangle]
unsafe extern "system" fn EventSetInformation(
    _reg_handle: u64,
    _information_class: i32,
    _information: *const c_void,
    _information_length: u32,
) -> u32 {
    0
}

#[no_mangle]
unsafe extern "system" fn EventWriteTransfer(
    _reg_handle: u64,
    _descriptor: *const c_void,
    _activity_id: *const c_void,
    _related_activity_id: *const c_void,
    _user_data_count: u32,
    _user_data: *const c_void,
) -> u32 {
    0
}

// The CRT calls these through `__imp_*` IAT pointers (the functions are declared
// `__declspec(dllimport)`). Define those pointers so no advapi32 import is created.
#[no_mangle]
#[used]
static __imp_EventRegister: unsafe extern "system" fn(
    *const c_void,
    *const c_void,
    *const c_void,
    *mut u64,
) -> u32 = EventRegister;

#[no_mangle]
#[used]
static __imp_EventUnregister: unsafe extern "system" fn(u64) -> u32 = EventUnregister;

#[no_mangle]
#[used]
static __imp_EventSetInformation: unsafe extern "system" fn(
    u64,
    i32,
    *const c_void,
    u32,
) -> u32 = EventSetInformation;

#[no_mangle]
#[used]
static __imp_EventWriteTransfer: unsafe extern "system" fn(
    u64,
    *const c_void,
    *const c_void,
    *const c_void,
    u32,
    *const c_void,
) -> u32 = EventWriteTransfer;
