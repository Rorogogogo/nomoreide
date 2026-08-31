//! What the machine itself is doing: CPU, memory, load, uptime and disk.
//!
//! The Rust half of `src/core/host-metrics.ts`. The reference reads these
//! through Node's `os` module, which on macOS is the Mach kernel and on Linux
//! is `/proc` — so this calls the same two sources rather than shelling out to
//! `top` or `vm_stat`, whose output format is a moving target and whose cost is
//! a process per sample.
//!
//! **No new dependency.** `libc` already covers load average, disk and the two
//! sysctls; the four Mach entry points it does not declare are declared here
//! directly. That is a dozen lines of `extern` against libSystem, against a
//! crate that would have brought a tree of its own for the same four symbols.
//!
//! Every reading degrades rather than fails: a sample with no CPU percentage is
//! still a sample worth drawing, and a disk that cannot be stat'd leaves one
//! panel empty instead of blanking the page.

use serde_json::{json, Value};

/// Cumulative processor ticks, summed across every logical CPU.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CpuTimes {
    pub idle: f64,
    pub total: f64,
}

/// One reading, in the shape the dashboard draws.
pub struct HostMetricsCollector {
    path: String,
    previous_cpu: Option<CpuTimes>,
}

impl HostMetricsCollector {
    pub fn new(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            previous_cpu: None,
        }
    }

    /// **The first sample never has a CPU percentage**, and that is not a
    /// failure: a percentage is a ratio of two readings, and one reading is
    /// not two. The reference reports `null` there and so does this.
    pub fn sample(&mut self, now_ms: f64) -> Value {
        let current = cpu_times();
        let cpu_percent = match (self.previous_cpu, current) {
            (Some(previous), Some(current)) => calculate_cpu_percent(previous, current),
            _ => None,
        };
        if current.is_some() {
            self.previous_cpu = current;
        }

        let total = memory_total_bytes().max(0.0);
        let free = memory_free_bytes().clamp(0.0, total);
        let used = (total - free).max(0.0);

        json!({
            "t": crate::js_number::value(now_ms),
            "cpuPercent": cpu_percent.map(crate::js_number::value).unwrap_or(Value::Null),
            "memoryUsedBytes": crate::js_number::value(used),
            "memoryTotalBytes": crate::js_number::value(total),
            "memoryUsedPercent": crate::js_number::value(percent(used, total)),
            "loadAverage": load_average()
                .map(|load| Value::Array(load.iter().map(|v| crate::js_number::value(*v)).collect()))
                .unwrap_or(Value::Null),
            "uptimeSeconds": crate::js_number::value(uptime_seconds().max(0.0)),
            "logicalCpuCount": logical_cpu_count(),
            "disk": disk_usage(&self.path),
        })
    }
}

/// The share of the interval that was *not* idle.
///
/// Two readings the same distance apart give the same answer whatever the
/// interval, which is what makes this comparable across a sampler that drifts.
/// A non-advancing counter -- a suspended machine, or two samples in the same
/// tick -- has no ratio to report.
pub fn calculate_cpu_percent(previous: CpuTimes, current: CpuTimes) -> Option<f64> {
    let total_delta = current.total - previous.total;
    let idle_delta = current.idle - previous.idle;
    if total_delta <= 0.0 {
        return None;
    }
    Some(round_one(
        ((1.0 - idle_delta / total_delta) * 100.0).clamp(0.0, 100.0),
    ))
}

fn percent(value: f64, total: f64) -> f64 {
    if total <= 0.0 {
        return 0.0;
    }
    round_one(((value / total) * 100.0).clamp(0.0, 100.0))
}

/// `Math.round(value * 10) / 10`.
fn round_one(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn logical_cpu_count() -> Value {
    Value::from(
        std::thread::available_parallelism()
            .map(std::num::NonZeroUsize::get)
            .unwrap_or(1),
    )
}

/// One, five and fifteen minutes. Absent only where the platform has no such
/// idea of load.
fn load_average() -> Option<[f64; 3]> {
    let mut samples = [0.0_f64; 3];
    // Safe: writes exactly three doubles into a buffer of three.
    let filled = unsafe { libc::getloadavg(samples.as_mut_ptr(), 3) };
    (filled == 3).then_some(samples)
}

/// Total, used and available bytes for the filesystem holding `path`.
fn disk_usage(path: &str) -> Value {
    let Ok(c_path) = std::ffi::CString::new(path) else {
        return Value::Null;
    };
    let mut stats: libc::statfs = unsafe { std::mem::zeroed() };
    // Safe: a valid C string and a zeroed struct of the right type.
    if unsafe { libc::statfs(c_path.as_ptr(), &mut stats) } != 0 {
        return Value::Null;
    }
    let block = stats.f_bsize as f64;
    let total = block * stats.f_blocks as f64;
    let available = block * stats.f_bavail as f64;
    // `f_bfree` counts blocks free to *root*; the difference between it and
    // `f_bavail` is the reserve, which is used space as far as a user is
    // concerned but not space anyone may write to.
    let used = (total - block * stats.f_bfree as f64).max(0.0);
    json!({
        "path": path,
        "totalBytes": crate::js_number::value(total),
        "usedBytes": crate::js_number::value(used),
        "availableBytes": crate::js_number::value(available),
        "usedPercent": crate::js_number::value(percent(used, total)),
    })
}

// --- macOS: the Mach kernel --------------------------------------------------

#[cfg(target_os = "macos")]
mod platform {
    use super::CpuTimes;

    const KERN_SUCCESS: libc::c_int = 0;
    const HOST_VM_INFO: libc::c_int = 2;
    const PROCESSOR_CPU_LOAD_INFO: libc::c_int = 2;
    /// user, system, idle, nice — the four states macOS counts.
    const CPU_STATE_MAX: usize = 4;
    const CPU_STATE_IDLE: usize = 2;

    /// `vm_statistics_data_t`, of which only `free_count` is read. The layout
    /// is fixed by the kernel interface, so the whole struct is declared rather
    /// than guessed at with an offset.
    #[repr(C)]
    #[derive(Default)]
    struct VmStatistics {
        free_count: libc::c_uint,
        active_count: libc::c_uint,
        inactive_count: libc::c_uint,
        wire_count: libc::c_uint,
        zero_fill_count: libc::c_uint,
        reactivations: libc::c_uint,
        pageins: libc::c_uint,
        pageouts: libc::c_uint,
        faults: libc::c_uint,
        cow_faults: libc::c_uint,
        lookups: libc::c_uint,
        hits: libc::c_uint,
    }

    extern "C" {
        fn mach_host_self() -> libc::c_uint;
        fn host_statistics(
            host: libc::c_uint,
            flavor: libc::c_int,
            info: *mut libc::c_int,
            count: *mut libc::c_uint,
        ) -> libc::c_int;
        fn host_processor_info(
            host: libc::c_uint,
            flavor: libc::c_int,
            processor_count: *mut libc::c_uint,
            info: *mut *mut libc::c_int,
            info_count: *mut libc::c_uint,
        ) -> libc::c_int;
        fn vm_deallocate(
            target: libc::c_uint,
            address: libc::uintptr_t,
            size: libc::size_t,
        ) -> libc::c_int;
        fn mach_task_self() -> libc::c_uint;
    }

    fn sysctl_u64(name: &str) -> Option<u64> {
        let key = std::ffi::CString::new(name).ok()?;
        let mut value: u64 = 0;
        let mut size = std::mem::size_of::<u64>();
        // Safe: a valid key, and a buffer whose size is passed alongside it.
        let ok = unsafe {
            libc::sysctlbyname(
                key.as_ptr(),
                &mut value as *mut u64 as *mut libc::c_void,
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        (ok == 0).then_some(value)
    }

    pub(super) fn memory_total_bytes() -> f64 {
        sysctl_u64("hw.memsize").unwrap_or(0) as f64
    }

    pub(super) fn memory_free_bytes() -> f64 {
        let mut stats = VmStatistics::default();
        let mut count =
            (std::mem::size_of::<VmStatistics>() / std::mem::size_of::<libc::c_int>()) as u32;
        // Safe: the flavor and the struct match, and the count is derived from
        // the struct's own size rather than assumed.
        let ok = unsafe {
            host_statistics(
                mach_host_self(),
                HOST_VM_INFO,
                &mut stats as *mut VmStatistics as *mut libc::c_int,
                &mut count,
            )
        };
        if ok != KERN_SUCCESS {
            return 0.0;
        }
        // Safe: reads a page size the kernel guarantees is positive.
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as f64;
        f64::from(stats.free_count) * page
    }

    /// Ticks summed over every logical CPU.
    ///
    /// macOS counts four states where Linux counts more; the reference sums
    /// whichever ones its platform reports, so the totals are only ever
    /// compared against an earlier reading from the same machine.
    pub(super) fn cpu_times() -> Option<CpuTimes> {
        let mut processors: libc::c_uint = 0;
        let mut info: *mut libc::c_int = std::ptr::null_mut();
        let mut info_count: libc::c_uint = 0;
        // Safe: out-parameters only; the buffer it allocates is freed below.
        let ok = unsafe {
            host_processor_info(
                mach_host_self(),
                PROCESSOR_CPU_LOAD_INFO,
                &mut processors,
                &mut info,
                &mut info_count,
            )
        };
        if ok != KERN_SUCCESS || info.is_null() {
            return None;
        }

        let mut times = CpuTimes {
            idle: 0.0,
            total: 0.0,
        };
        // Safe: the kernel reported how many integers it wrote, and the loop
        // reads exactly that many.
        let ticks = unsafe { std::slice::from_raw_parts(info, info_count as usize) };
        for cpu in 0..processors as usize {
            let base = cpu * CPU_STATE_MAX;
            if base + CPU_STATE_MAX > ticks.len() {
                break;
            }
            for state in 0..CPU_STATE_MAX {
                let value = f64::from(ticks[base + state] as u32);
                times.total += value;
                if state == CPU_STATE_IDLE {
                    times.idle += value;
                }
            }
        }
        // Safe: frees the buffer the kernel allocated, exactly once.
        unsafe {
            vm_deallocate(
                mach_task_self(),
                info as libc::uintptr_t,
                info_count as libc::size_t * std::mem::size_of::<libc::c_int>(),
            );
        }
        Some(times)
    }

    pub(super) fn uptime_seconds() -> f64 {
        let key = match std::ffi::CString::new("kern.boottime") {
            Ok(key) => key,
            Err(_) => return 0.0,
        };
        let mut boot: libc::timeval = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of::<libc::timeval>();
        // Safe: a valid key and a buffer sized for what it returns.
        let ok = unsafe {
            libc::sysctlbyname(
                key.as_ptr(),
                &mut boot as *mut libc::timeval as *mut libc::c_void,
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if ok != 0 || boot.tv_sec == 0 {
            return 0.0;
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_secs_f64())
            .unwrap_or(0.0);
        (now - boot.tv_sec as f64).max(0.0)
    }
}

// --- Linux: /proc ------------------------------------------------------------

#[cfg(target_os = "linux")]
mod platform {
    use super::CpuTimes;

    pub(super) fn memory_total_bytes() -> f64 {
        meminfo_bytes("MemTotal:")
    }

    /// `MemAvailable` where the kernel offers it, which is the number a user
    /// means by "free" — `MemFree` excludes reclaimable cache and reads far
    /// lower than the machine actually has.
    pub(super) fn memory_free_bytes() -> f64 {
        let available = meminfo_bytes("MemAvailable:");
        if available > 0.0 {
            available
        } else {
            meminfo_bytes("MemFree:")
        }
    }

    fn meminfo_bytes(key: &str) -> f64 {
        let Ok(text) = std::fs::read_to_string("/proc/meminfo") else {
            return 0.0;
        };
        text.lines()
            .find_map(|line| line.strip_prefix(key))
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|value| value.parse::<f64>().ok())
            // /proc/meminfo is in kibibytes.
            .map(|kib| kib * 1024.0)
            .unwrap_or(0.0)
    }

    pub(super) fn cpu_times() -> Option<CpuTimes> {
        let text = std::fs::read_to_string("/proc/stat").ok()?;
        let line = text.lines().find(|line| line.starts_with("cpu "))?;
        let fields: Vec<f64> = line
            .split_whitespace()
            .skip(1)
            .filter_map(|value| value.parse::<f64>().ok())
            .collect();
        if fields.len() < 4 {
            return None;
        }
        Some(CpuTimes {
            idle: fields[3],
            total: fields.iter().sum(),
        })
    }

    pub(super) fn uptime_seconds() -> f64 {
        std::fs::read_to_string("/proc/uptime")
            .ok()
            .and_then(|text| text.split_whitespace().next().map(str::to_string))
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod platform {
    use super::CpuTimes;
    pub(super) fn memory_total_bytes() -> f64 {
        0.0
    }
    pub(super) fn memory_free_bytes() -> f64 {
        0.0
    }
    pub(super) fn cpu_times() -> Option<CpuTimes> {
        None
    }
    pub(super) fn uptime_seconds() -> f64 {
        0.0
    }
}

use platform::{cpu_times, memory_free_bytes, memory_total_bytes, uptime_seconds};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_percentage_needs_two_readings() {
        let first = CpuTimes {
            idle: 100.0,
            total: 200.0,
        };
        assert_eq!(calculate_cpu_percent(first, first), None, "no movement");
        let second = CpuTimes {
            idle: 150.0,
            total: 300.0,
        };
        // Half the added ticks were idle, so half the interval was busy.
        assert_eq!(calculate_cpu_percent(first, second), Some(50.0));
    }

    #[test]
    fn a_counter_that_went_backwards_reports_nothing() {
        let later = CpuTimes {
            idle: 10.0,
            total: 20.0,
        };
        let earlier = CpuTimes {
            idle: 5.0,
            total: 10.0,
        };
        assert_eq!(calculate_cpu_percent(later, earlier), None);
    }

    #[test]
    fn a_percentage_is_rounded_to_one_place_and_clamped() {
        assert_eq!(percent(1.0, 3.0), 33.3);
        assert_eq!(percent(1.0, 0.0), 0.0, "nothing to be a fraction of");
        assert_eq!(percent(5.0, 4.0), 100.0, "clamped rather than over one");
    }

    #[test]
    fn the_first_sample_has_no_cpu_percentage() {
        let mut collector = HostMetricsCollector::new("/");
        let first = collector.sample(1_000.0);
        assert_eq!(first["cpuPercent"], Value::Null);
        assert_eq!(first["t"], Value::from(1000));
        // The machine this runs on has memory and at least one CPU.
        assert!(first["memoryTotalBytes"].as_f64().unwrap_or(0.0) > 0.0);
        assert!(first["logicalCpuCount"].as_u64().unwrap_or(0) >= 1);
        assert!(first["disk"].is_object(), "the root filesystem stats");
    }
}
