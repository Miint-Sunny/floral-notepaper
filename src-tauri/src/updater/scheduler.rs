use super::{commands, settings, types::UpdateErrorDto, UpdatePaths, UpdaterState};
use crate::services::notes::AppError;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use std::{thread, time::Duration};
use tauri::{AppHandle, Emitter, Manager};

const INITIAL_DELAY: Duration = Duration::from_secs(3);
// 动态休眠边界：距下次到期还远时最多睡 MAX_SLEEP（不再固定每 60s 空转读盘解析 settings）；
// 临近到期时睡剩余时长，但至少 MIN_SLEEP，避免忙轮询。检查及时性仍在 MIN 粒度内（同原 60s）。
const MIN_SLEEP: Duration = Duration::from_secs(60);
const MAX_SLEEP: Duration = Duration::from_secs(15 * 60);

pub fn start_auto_check_scheduler(app: AppHandle) {
    thread::spawn(move || {
        thread::sleep(INITIAL_DELAY);

        loop {
            if let Err(error) = poll_auto_check(&app, Utc::now()) {
                eprintln!("failed to run automatic update check: {error}");
                let payload =
                    UpdateErrorDto::recoverable(error.code, error.message, Some("retry".into()));
                if let Err(emit_error) = app.emit("update://auto-check-error", payload) {
                    eprintln!("failed to emit update://auto-check-error: {emit_error}");
                }
            }

            thread::sleep(next_poll_delay(&app, Utc::now()));
        }
    });
}

// 距下次自动检查到期还要多久就睡多久。读不到 updater state / settings 时回退 MAX_SLEEP。
fn next_poll_delay(app: &AppHandle, now: DateTime<Utc>) -> Duration {
    let Some(state) = app.try_state::<UpdaterState>() else {
        return MAX_SLEEP;
    };
    let Ok(settings) = settings::load(state.paths()) else {
        return MAX_SLEEP;
    };
    sleep_until_due(&settings, now)
}

// 纯逻辑：按 settings 算到下次到期的休眠时长，clamp 到 [MIN_SLEEP, MAX_SLEEP]。
// 关闭自动检查 → MAX；从未检查过 → MIN（尽快检查）；已逾期 → MIN；否则取剩余时长。
fn sleep_until_due(settings: &settings::StoredUpdateSettings, now: DateTime<Utc>) -> Duration {
    if !settings.auto_check {
        return MAX_SLEEP;
    }
    let Some(last) = settings.last_auto_check_at else {
        return MIN_SLEEP;
    };
    let interval = ChronoDuration::hours(i64::from(settings.check_interval_hours));
    (last + interval)
        .signed_duration_since(now)
        .to_std()
        .unwrap_or(MIN_SLEEP)
        .clamp(MIN_SLEEP, MAX_SLEEP)
}

fn poll_auto_check(app: &AppHandle, now: DateTime<Utc>) -> Result<(), AppError> {
    let Some(state) = app.try_state::<UpdaterState>() else {
        return Ok(());
    };

    let _ = maybe_run_due_check(state.paths(), now, || {
        commands::run_automatic_update_check(app.clone(), state.inner()).map(|_| ())
    })?;

    Ok(())
}

fn should_auto_check(settings: &settings::StoredUpdateSettings, now: DateTime<Utc>) -> bool {
    if !settings.auto_check {
        return false;
    }

    let Some(last_checked_at) = settings.last_auto_check_at else {
        return true;
    };

    let interval = ChronoDuration::hours(i64::from(settings.check_interval_hours));
    now.signed_duration_since(last_checked_at) >= interval
}

pub(crate) fn maybe_run_due_check<F>(
    paths: &UpdatePaths,
    now: DateTime<Utc>,
    mut runner: F,
) -> Result<bool, AppError>
where
    F: FnMut() -> Result<(), AppError>,
{
    let settings = settings::load(paths)?;
    if !should_auto_check(&settings, now) {
        return Ok(false);
    }

    match runner() {
        Ok(()) => Ok(true),
        Err(error) if error.code == "updateAlreadyRunning" => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::updater::{
        errors,
        settings::StoredUpdateSettings,
        types::{CheckSourcePreference, DownloadSourcePreference, UpdateChannel},
    };
    use std::{
        fs,
        sync::atomic::{AtomicUsize, Ordering},
    };

    fn test_paths(name: &str) -> UpdatePaths {
        let root = std::env::temp_dir()
            .join("floral-notepaper-updater-tests")
            .join(name);
        if root.exists() {
            fs::remove_dir_all(&root).expect("remove stale test dir");
        }
        UpdatePaths::new(root)
    }

    fn save_settings(
        paths: &UpdatePaths,
        auto_check: bool,
        last_auto_check_at: Option<DateTime<Utc>>,
        check_interval_hours: u32,
    ) {
        settings::save(
            paths,
            &StoredUpdateSettings {
                auto_check,
                auto_download: false,
                check_interval_hours,
                check_source_preference: CheckSourcePreference::GithubFirst,
                download_source_preference: DownloadSourcePreference::MirrorChyanFirst,
                channel: UpdateChannel::Stable,
                allow_prerelease: false,
                last_auto_check_at,
            },
        )
        .expect("save update settings");
    }

    fn make_settings(
        auto_check: bool,
        last_auto_check_at: Option<DateTime<Utc>>,
        check_interval_hours: u32,
    ) -> StoredUpdateSettings {
        StoredUpdateSettings {
            auto_check,
            auto_download: false,
            check_interval_hours,
            check_source_preference: CheckSourcePreference::GithubFirst,
            download_source_preference: DownloadSourcePreference::MirrorChyanFirst,
            channel: UpdateChannel::Stable,
            allow_prerelease: false,
            last_auto_check_at,
        }
    }

    #[test]
    fn sleep_until_due_caps_far_future_at_max() {
        // 刚检查过（剩 ~24h）→ 取上限 MAX_SLEEP，不每 60s 空转。
        let settings = make_settings(true, Some(Utc::now()), 24);
        assert_eq!(sleep_until_due(&settings, Utc::now()), MAX_SLEEP);
    }

    #[test]
    fn sleep_until_due_floors_overdue_at_min() {
        // 早已逾期（上次在 48h 前、间隔 24h）→ 尽快检查 = MIN_SLEEP。
        let settings = make_settings(true, Some(Utc::now() - ChronoDuration::hours(48)), 24);
        assert_eq!(sleep_until_due(&settings, Utc::now()), MIN_SLEEP);
    }

    #[test]
    fn sleep_until_due_disabled_sleeps_max() {
        assert_eq!(
            sleep_until_due(&make_settings(false, None, 24), Utc::now()),
            MAX_SLEEP
        );
    }

    #[test]
    fn sleep_until_due_never_checked_sleeps_min() {
        assert_eq!(
            sleep_until_due(&make_settings(true, None, 24), Utc::now()),
            MIN_SLEEP
        );
    }

    #[test]
    fn sleep_until_due_returns_remaining_within_bounds() {
        // 剩约 5 分钟（在 [MIN,MAX] 内）→ 返回剩余时长本身。
        let last = Utc::now() - ChronoDuration::hours(24) + ChronoDuration::minutes(5);
        let delay = sleep_until_due(&make_settings(true, Some(last), 24), Utc::now());
        assert!(delay >= MIN_SLEEP && delay <= MAX_SLEEP);
        assert!(delay.as_secs() >= 4 * 60 && delay.as_secs() <= 6 * 60);
    }

    #[test]
    fn does_not_trigger_when_auto_check_is_disabled() {
        let paths = test_paths("scheduler-disabled");
        save_settings(&paths, false, None, 24);
        let calls = AtomicUsize::new(0);

        let triggered = maybe_run_due_check(&paths, Utc::now(), || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .expect("disabled auto check should not error");

        assert!(!triggered);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn triggers_immediately_when_no_previous_auto_check_exists() {
        let paths = test_paths("scheduler-first-run");
        save_settings(&paths, true, None, 24);
        let calls = AtomicUsize::new(0);

        let triggered = maybe_run_due_check(&paths, Utc::now(), || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .expect("first auto check should not error");

        assert!(triggered);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn skips_when_interval_has_not_elapsed() {
        let paths = test_paths("scheduler-not-due");
        save_settings(
            &paths,
            true,
            Some(Utc::now() - ChronoDuration::hours(12)),
            24,
        );
        let calls = AtomicUsize::new(0);

        let triggered = maybe_run_due_check(&paths, Utc::now(), || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .expect("not due auto check should not error");

        assert!(!triggered);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn triggers_once_when_interval_has_elapsed() {
        let paths = test_paths("scheduler-due");
        save_settings(
            &paths,
            true,
            Some(Utc::now() - ChronoDuration::hours(25)),
            24,
        );
        let calls = AtomicUsize::new(0);

        let triggered = maybe_run_due_check(&paths, Utc::now(), || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .expect("due auto check should not error");

        assert!(triggered);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn skips_busy_iterations_without_overwriting_last_auto_check_at() {
        let paths = test_paths("scheduler-busy");
        let last_auto_check_at = Utc::now() - ChronoDuration::hours(48);
        save_settings(&paths, true, Some(last_auto_check_at), 24);

        let triggered = maybe_run_due_check(&paths, Utc::now(), || {
            Err(errors::app_error(
                "updateAlreadyRunning",
                "已有更新任务正在运行",
            ))
        })
        .expect("busy auto check should be ignored");

        assert!(!triggered);
        assert_eq!(
            settings::load(&paths)
                .expect("load saved settings")
                .last_auto_check_at,
            Some(last_auto_check_at)
        );
    }
}
