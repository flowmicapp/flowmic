// GENERATED — DO NOT EDIT BY HAND.
// Source: packages/protocol/src/locales.ts (UI_LOCALES) + i18n/desktop-rust/<code>.json
// Regenerate: node scripts/i18n/gen-desktop-rust.mjs
// Count: 9 locale(s) x 26 message(s) = 234 cell(s).
// Every registry row has a data file on this surface.
//
// `include!`d by src/ui_i18n.rs, so this shares that module's namespace: `Msg`
// and the per-key doc comments that pin each key to its production call site
// live THERE (the key contract is authored, only the data is generated).
//
// 🔴 THIS FILE IS COMMITTED. `*.g.dart` is gitignored because a pnpm step
// rebuilds it; cargo has no codegen step, so a gitignored table would not
// compile on a clean checkout. Running the generator with `--check` is what
// keeps the committed copy honest.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiLocale {
    /// `en` — English (Latn).
    En,
    /// `zh-CN` — 中文 (Hans).
    ZhCn,
    /// `zh-TW` — 繁體中文 (Hant).
    ZhTw,
    /// `fr` — Français (Latn).
    Fr,
    /// `es` — Español (Latn).
    Es,
    /// `de` — Deutsch (Latn).
    De,
    /// `ja` — 日本語 (Jpan).
    Ja,
    /// `ko` — 한국어 (Kore).
    Ko,
    /// `ru` — Русский (Cyrl).
    Ru,
}

impl UiLocale {
    /// Every shipped UI locale, in registry (display) order.
    ///
    /// 🔴 A SLICE, not `[UiLocale; N]`. The old array wrote the number of
    /// languages into a TYPE, which is the single most expensive line in the
    /// old add-a-language bill: it cannot be derived, so it can only be
    /// remembered. Nothing in this crate now states how many languages exist.
    pub const ALL: &'static [UiLocale] = &[
        UiLocale::En,
        UiLocale::ZhCn,
        UiLocale::ZhTw,
        UiLocale::Fr,
        UiLocale::Es,
        UiLocale::De,
        UiLocale::Ja,
        UiLocale::Ko,
        UiLocale::Ru,
    ];

    /// The persisted tag — byte-identical to the `code` field of the registry
    /// row, which is what the WebView stores under `flowmic.ui.locale` and what
    /// `ui_locale_set` (shell/locale_sync.rs) is handed.
    pub fn tag(self) -> &'static str {
        match self {
            UiLocale::En => "en",
            UiLocale::ZhCn => "zh-CN",
            UiLocale::ZhTw => "zh-TW",
            UiLocale::Fr => "fr",
            UiLocale::Es => "es",
            UiLocale::De => "de",
            UiLocale::Ja => "ja",
            UiLocale::Ko => "ko",
            UiLocale::Ru => "ru",
        }
    }
}

/// The product default when nothing was ever chosen — the registry's
/// `DEFAULT_UI_LOCALE`, so the Rust shell and the WebView cannot disagree about
/// which language the first frame is in. NEVER derived from the OS (red line).
pub const DEFAULT_LOCALE: UiLocale = UiLocale::En;

/// Index of [DEFAULT_LOCALE] inside [UiLocale::ALL].
///
/// Generated because AtomicU8::new needs a const and position() is not one.
/// Before this existed, CURRENT started at 0 and a test pinned the COINCIDENCE
/// that row 0 happened to be the default. The 2026-08-14 registry reorder (English
/// moved first, as the base language) broke that coincidence and the test caught
/// it — which is the test working. Emitting the real index removes the luck
/// instead of re-pinning a new coincidence.
pub const DEFAULT_LOCALE_INDEX: u8 = 0;

/// The two registry columns the table test reasons about, mirrored verbatim.
///
/// 🔴 `#[cfg(test)]` ON PURPOSE. Their only consumer today is the anti-copy-paste
/// test in `ui_i18n.rs`; an exported symbol with no caller is this repo's #1
/// historical defect class, so they are gated rather than left `pub` and unused.
/// When a production consumer appears — the Rust twin of `SCRIPT_WIDTH_FACTOR`
/// is the obvious candidate — drop the `cfg`.
///
/// `script` is the ISO 15924 code as a string rather than an enum so that a
/// registry row with a NEW script does not turn into a non-exhaustive match in
/// a file nobody edits: the rule table in `ui_i18n.rs` refuses an unknown script
/// out loud instead.
#[cfg(test)]
impl UiLocale {
    pub fn script(self) -> &'static str {
        match self {
            UiLocale::En => "Latn",
            UiLocale::ZhCn => "Hans",
            UiLocale::ZhTw => "Hant",
            UiLocale::Fr => "Latn",
            UiLocale::Es => "Latn",
            UiLocale::De => "Latn",
            UiLocale::Ja => "Jpan",
            UiLocale::Ko => "Kore",
            UiLocale::Ru => "Cyrl",
        }
    }

    /// True for the languages whose copy is WRITTEN, not translated (17 册 §1).
    /// The table test compares translations AGAINST these and never the reverse.
    pub fn is_authored(self) -> bool {
        match self {
            UiLocale::En => true,
            UiLocale::ZhCn => true,
            UiLocale::ZhTw => false,
            UiLocale::Fr => false,
            UiLocale::Es => false,
            UiLocale::De => false,
            UiLocale::Ja => false,
            UiLocale::Ko => false,
            UiLocale::Ru => false,
        }
    }
}

impl Msg {
    /// Every key, in the order the authored language's data file lists them.
    /// A slice for the same reason `UiLocale::ALL` is one — the count of keys
    /// is data, not type information.
    pub const ALL: &'static [Msg] = &[
        Msg::TrayShowMain,
        Msg::TrayShowCapsule,
        Msg::TrayQuit,
        Msg::TrayStatusDisconnected,
        Msg::TrayTooltipDisconnected,
        Msg::TrayGoOffline,
        Msg::TrayGoOnline,
        Msg::TrayStatusOffline,
        Msg::TrayTooltipOffline,
        Msg::TrayStatusRecording,
        Msg::TrayTooltipRecording,
        Msg::TrayStatusConnected,
        Msg::TrayTooltipConnected,
        Msg::QuitConfirmTitle,
        Msg::QuitConfirmBody,
        Msg::AutostartWriteFailed,
        Msg::AutostartRemoveFailed,
        Msg::AutostartReadFailed,
        Msg::AutostartExePathFailed,
        Msg::AutostartVerifyMismatch,
        Msg::AutostartVerifyEmpty,
        Msg::AutostartRecheckFailed,
        Msg::AutostartEnabledButOff,
        Msg::AutostartStillEnabled,
        Msg::AutostartRegOpenFailed,
        Msg::AutostartRewriteFailed,
    ];
}

/// The strings. Exhaustive on both axes, so the compiler — not a runtime
/// fallback, not a test — is what refuses an incomplete table.
fn table(locale: UiLocale, msg: Msg) -> &'static str {
    match msg {
        Msg::TrayShowMain => match locale {
            UiLocale::En => "Show main window",
            UiLocale::ZhCn => "显示主窗口",
            UiLocale::ZhTw => "顯示主視窗",
            UiLocale::Fr => "Afficher la fenêtre principale",
            UiLocale::Es => "Mostrar la ventana principal",
            UiLocale::De => "Hauptfenster anzeigen",
            UiLocale::Ja => "メインウィンドウを表示",
            UiLocale::Ko => "메인 창 표시",
            UiLocale::Ru => "Показать главное окно",
        },
        Msg::TrayShowCapsule => match locale {
            UiLocale::En => "Show capsule",
            UiLocale::ZhCn => "显示胶囊",
            UiLocale::ZhTw => "顯示膠囊",
            UiLocale::Fr => "Afficher la capsule",
            UiLocale::Es => "Mostrar la cápsula",
            UiLocale::De => "Kapsel anzeigen",
            UiLocale::Ja => "カプセルを表示",
            UiLocale::Ko => "캡슐 표시",
            UiLocale::Ru => "Показать капсулу",
        },
        Msg::TrayQuit => match locale {
            UiLocale::En => "Quit",
            UiLocale::ZhCn => "退出",
            UiLocale::ZhTw => "結束",
            UiLocale::Fr => "Quitter",
            UiLocale::Es => "Salir",
            UiLocale::De => "Beenden",
            UiLocale::Ja => "終了",
            UiLocale::Ko => "종료",
            UiLocale::Ru => "Выход",
        },
        Msg::TrayStatusDisconnected => match locale {
            UiLocale::En => "● Not connected",
            UiLocale::ZhCn => "● 未连接",
            UiLocale::ZhTw => "● 未連線",
            UiLocale::Fr => "● Non connecté",
            UiLocale::Es => "● Sin conexión",
            UiLocale::De => "● Nicht verbunden",
            UiLocale::Ja => "● 未接続",
            UiLocale::Ko => "● 연결 안 됨",
            UiLocale::Ru => "● Нет подключения",
        },
        Msg::TrayTooltipDisconnected => match locale {
            UiLocale::En => "FlowMic — not connected",
            UiLocale::ZhCn => "FlowMic — 未连接",
            UiLocale::ZhTw => "FlowMic — 未連線",
            UiLocale::Fr => "FlowMic — non connecté",
            UiLocale::Es => "FlowMic — sin conexión",
            UiLocale::De => "FlowMic — nicht verbunden",
            UiLocale::Ja => "FlowMic — 未接続",
            UiLocale::Ko => "FlowMic — 연결 안 됨",
            UiLocale::Ru => "FlowMic — нет подключения",
        },
        Msg::TrayGoOffline => match locale {
            UiLocale::En => "Go offline (pause phone connections)",
            UiLocale::ZhCn => "下线（暂停手机连接）",
            UiLocale::ZhTw => "下線（暫停手機連線）",
            UiLocale::Fr => "Passer hors ligne (suspendre les connexions du téléphone)",
            UiLocale::Es => "Desconectarse (pausar conexiones del teléfono)",
            UiLocale::De => "Offline gehen (Telefonverbindungen pausieren)",
            UiLocale::Ja => "オフラインにする（スマホ接続を一時停止）",
            UiLocale::Ko => "오프라인 전환 (휴대폰 연결 일시 중지)",
            UiLocale::Ru => "Уйти в офлайн (приостановить подключения телефона)",
        },
        Msg::TrayGoOnline => match locale {
            UiLocale::En => "Go online (resume phone connections)",
            UiLocale::ZhCn => "上线（恢复手机连接）",
            UiLocale::ZhTw => "上線（恢復手機連線）",
            UiLocale::Fr => "Repasser en ligne (reprendre les connexions du téléphone)",
            UiLocale::Es => "Conectarse (reanudar conexiones del teléfono)",
            UiLocale::De => "Online gehen (Telefonverbindungen fortsetzen)",
            UiLocale::Ja => "オンラインに戻る（スマホ接続を再開）",
            UiLocale::Ko => "온라인 전환 (휴대폰 연결 재개)",
            UiLocale::Ru => "Вернуться в онлайн (возобновить подключения телефона)",
        },
        Msg::TrayStatusOffline => match locale {
            UiLocale::En => "● Offline",
            UiLocale::ZhCn => "● 已下线",
            UiLocale::ZhTw => "● 已下線",
            UiLocale::Fr => "● Hors ligne",
            UiLocale::Es => "● Desconectado",
            UiLocale::De => "● Offline",
            UiLocale::Ja => "● オフライン",
            UiLocale::Ko => "● 오프라인",
            UiLocale::Ru => "● Офлайн",
        },
        Msg::TrayTooltipOffline => match locale {
            UiLocale::En => "FlowMic — offline (phone connections paused)",
            UiLocale::ZhCn => "FlowMic — 已下线（手机连接已暂停）",
            UiLocale::ZhTw => "FlowMic — 已下線（手機連線已暫停）",
            UiLocale::Fr => "FlowMic — hors ligne (connexions du téléphone suspendues)",
            UiLocale::Es => "FlowMic — desconectado (conexiones del teléfono en pausa)",
            UiLocale::De => "FlowMic — offline (Telefonverbindungen pausiert)",
            UiLocale::Ja => "FlowMic — オフライン（スマホ接続は一時停止中）",
            UiLocale::Ko => "FlowMic — 오프라인 (휴대폰 연결 일시 중지됨)",
            UiLocale::Ru => "FlowMic — офлайн (подключения телефона приостановлены)",
        },
        Msg::TrayStatusRecording => match locale {
            UiLocale::En => "● Recording",
            UiLocale::ZhCn => "● 录音中",
            UiLocale::ZhTw => "● 錄音中",
            UiLocale::Fr => "● Enregistrement",
            UiLocale::Es => "● Grabando",
            UiLocale::De => "● Nimmt auf",
            UiLocale::Ja => "● 録音中",
            UiLocale::Ko => "● 녹음 중",
            UiLocale::Ru => "● Идёт запись",
        },
        Msg::TrayTooltipRecording => match locale {
            UiLocale::En => "FlowMic — recording",
            UiLocale::ZhCn => "FlowMic — 正在录音",
            UiLocale::ZhTw => "FlowMic — 正在錄音",
            UiLocale::Fr => "FlowMic — enregistrement en cours",
            UiLocale::Es => "FlowMic — grabando",
            UiLocale::De => "FlowMic — nimmt auf",
            UiLocale::Ja => "FlowMic — 録音中",
            UiLocale::Ko => "FlowMic — 녹음 중",
            UiLocale::Ru => "FlowMic — идёт запись",
        },
        Msg::TrayStatusConnected => match locale {
            UiLocale::En => "● Connected · {n} phone(s)",
            UiLocale::ZhCn => "● 已连接 · {n} 台手机",
            UiLocale::ZhTw => "● 已連線 · {n} 台手機",
            UiLocale::Fr => "● Connecté · {n} téléphone(s)",
            UiLocale::Es => "● Conectado · {n} teléfono(s)",
            UiLocale::De => "● Verbunden · {n} Telefon(e)",
            UiLocale::Ja => "● 接続済み · スマホ {n} 台",
            UiLocale::Ko => "● 연결됨 · 휴대폰 {n}대",
            UiLocale::Ru => "● Подключено · телефонов: {n}",
        },
        Msg::TrayTooltipConnected => match locale {
            UiLocale::En => "FlowMic — connected ({n} phone(s) online)",
            UiLocale::ZhCn => "FlowMic — 已连接（{n} 部手机在线）",
            UiLocale::ZhTw => "FlowMic — 已連線（{n} 部手機在線上）",
            UiLocale::Fr => "FlowMic — connecté ({n} téléphone(s) en ligne)",
            UiLocale::Es => "FlowMic — conectado ({n} teléfono(s) en línea)",
            UiLocale::De => "FlowMic — verbunden ({n} Telefon(e) online)",
            UiLocale::Ja => "FlowMic — 接続済み（スマホ {n} 台がオンライン）",
            UiLocale::Ko => "FlowMic — 연결됨 (휴대폰 {n}대 온라인)",
            UiLocale::Ru => "FlowMic — подключено (телефонов в сети: {n})",
        },
        Msg::QuitConfirmTitle => match locale {
            UiLocale::En => "Quit FlowMic",
            UiLocale::ZhCn => "退出 FlowMic",
            UiLocale::ZhTw => "結束 FlowMic",
            UiLocale::Fr => "Quitter FlowMic",
            UiLocale::Es => "Salir de FlowMic",
            UiLocale::De => "FlowMic beenden",
            UiLocale::Ja => "FlowMic を終了",
            UiLocale::Ko => "FlowMic 종료",
            UiLocale::Ru => "Выйти из FlowMic",
        },
        Msg::QuitConfirmBody => match locale {
            UiLocale::En => "After you quit, phones can no longer connect to this PC, and any transcription in progress will be interrupted.\n\nQuit FlowMic?",
            UiLocale::ZhCn => "退出后手机将无法连接到这台电脑，正在进行的转录会中断。\n\n确定要退出 FlowMic 吗？",
            UiLocale::ZhTw => "結束後手機將無法連線到這台電腦，正在進行的轉錄會中斷。\n\n確定要結束 FlowMic 嗎？",
            UiLocale::Fr => "Après la fermeture, les téléphones ne pourront plus se connecter à ce PC et toute transcription en cours sera interrompue.\n\nQuitter FlowMic ?",
            UiLocale::Es => "Después de salir, los teléfonos ya no podrán conectarse a este PC y se interrumpirá cualquier transcripción en curso.\n\n¿Salir de FlowMic?",
            UiLocale::De => "Nach dem Beenden können sich Telefone nicht mehr mit diesem PC verbinden, und eine laufende Transkription wird abgebrochen.\n\nFlowMic beenden?",
            UiLocale::Ja => "終了するとスマホはこの PC に接続できなくなり、進行中の文字起こしは中断されます。\n\nFlowMic を終了しますか？",
            UiLocale::Ko => "종료하면 휴대폰이 이 PC에 연결할 수 없게 되며, 진행 중인 전사는 중단됩니다.\n\nFlowMic을 종료하시겠습니까?",
            UiLocale::Ru => "После выхода телефоны не смогут подключиться к этому компьютеру, а текущая транскрипция прервётся.\n\nВыйти из FlowMic?",
        },
        Msg::AutostartWriteFailed => match locale {
            UiLocale::En => "Failed to write the startup entry: {detail}",
            UiLocale::ZhCn => "写入开机自启项失败：{detail}",
            UiLocale::ZhTw => "寫入開機自動啟動項目失敗：{detail}",
            UiLocale::Fr => "Échec de l'écriture de l'entrée de démarrage : {detail}",
            UiLocale::Es => "No se pudo escribir la entrada de inicio: {detail}",
            UiLocale::De => "Der Autostart-Eintrag konnte nicht geschrieben werden: {detail}",
            UiLocale::Ja => "自動起動エントリの書き込みに失敗しました：{detail}",
            UiLocale::Ko => "시작 프로그램 항목 쓰기 실패: {detail}",
            UiLocale::Ru => "Не удалось записать запись автозапуска: {detail}",
        },
        Msg::AutostartRemoveFailed => match locale {
            UiLocale::En => "Failed to remove the startup entry: {detail}",
            UiLocale::ZhCn => "移除开机自启项失败：{detail}",
            UiLocale::ZhTw => "移除開機自動啟動項目失敗：{detail}",
            UiLocale::Fr => "Échec de la suppression de l'entrée de démarrage : {detail}",
            UiLocale::Es => "No se pudo quitar la entrada de inicio: {detail}",
            UiLocale::De => "Der Autostart-Eintrag konnte nicht entfernt werden: {detail}",
            UiLocale::Ja => "自動起動エントリの削除に失敗しました：{detail}",
            UiLocale::Ko => "시작 프로그램 항목 제거 실패: {detail}",
            UiLocale::Ru => "Не удалось удалить запись автозапуска: {detail}",
        },
        Msg::AutostartReadFailed => match locale {
            UiLocale::En => "Failed to read the startup state: {detail}",
            UiLocale::ZhCn => "读取开机自启状态失败：{detail}",
            UiLocale::ZhTw => "讀取開機自動啟動狀態失敗：{detail}",
            UiLocale::Fr => "Échec de la lecture de l'état de démarrage : {detail}",
            UiLocale::Es => "No se pudo leer el estado de inicio: {detail}",
            UiLocale::De => "Der Autostart-Status konnte nicht gelesen werden: {detail}",
            UiLocale::Ja => "自動起動状態の読み取りに失敗しました：{detail}",
            UiLocale::Ko => "시작 프로그램 상태 읽기 실패: {detail}",
            UiLocale::Ru => "Не удалось прочитать состояние автозапуска: {detail}",
        },
        Msg::AutostartExePathFailed => match locale {
            UiLocale::En => "Could not resolve the current executable path: {detail}",
            UiLocale::ZhCn => "无法解析当前程序路径：{detail}",
            UiLocale::ZhTw => "無法解析目前的程式路徑：{detail}",
            UiLocale::Fr => "Impossible de déterminer le chemin de l'exécutable actuel : {detail}",
            UiLocale::Es => "No se pudo determinar la ruta del ejecutable actual: {detail}",
            UiLocale::De => "Der Pfad der aktuellen Programmdatei konnte nicht ermittelt werden: {detail}",
            UiLocale::Ja => "現在の実行ファイルのパスを解決できません：{detail}",
            UiLocale::Ko => "현재 실행 파일 경로를 확인할 수 없습니다: {detail}",
            UiLocale::Ru => "Не удалось определить путь к текущему исполняемому файлу: {detail}",
        },
        Msg::AutostartVerifyMismatch => match locale {
            UiLocale::En => "Startup entry read-back mismatch: expected \"{want}\", found \"{got}\". A third-party startup manager may have rewritten it.",
            UiLocale::ZhCn => "开机自启项回读不符：期望「{want}」，实际「{got}」。可能有第三方启动管理工具改写了它。",
            UiLocale::ZhTw => "開機自動啟動項目回讀不符：預期「{want}」，實際「{got}」。可能有第三方啟動管理工具改寫了它。",
            UiLocale::Fr => "Relecture de l'entrée de démarrage non conforme : attendu « {want} », trouvé « {got} ». Un gestionnaire de démarrage tiers l'a peut-être réécrite.",
            UiLocale::Es => "La relectura de la entrada de inicio no coincide: se esperaba «{want}» y se encontró «{got}». Puede que un gestor de inicio de terceros la haya reescrito.",
            UiLocale::De => "Rückgelesener Autostart-Eintrag stimmt nicht: erwartet „{want}“, gefunden „{got}“. Möglicherweise hat ein fremder Autostart-Manager ihn überschrieben.",
            UiLocale::Ja => "自動起動エントリの読み戻しが一致しません：期待値「{want}」、実際「{got}」。サードパーティのスタートアップ管理ツールが書き換えた可能性があります。",
            UiLocale::Ko => "시작 프로그램 항목 재확인 불일치: 예상 \"{want}\", 실제 \"{got}\". 타사 시작 관리 도구가 변경했을 수 있습니다.",
            UiLocale::Ru => "Обратное чтение записи автозапуска не совпало: ожидалось «{want}», получено «{got}». Возможно, её переписал сторонний менеджер автозапуска.",
        },
        Msg::AutostartVerifyEmpty => match locale {
            UiLocale::En => "The startup entry read back empty after writing — the registration did not take effect",
            UiLocale::ZhCn => "开机自启项写入后回读为空——注册未生效",
            UiLocale::ZhTw => "開機自動啟動項目寫入後回讀為空——註冊未生效",
            UiLocale::Fr => "L'entrée de démarrage est revenue vide après l'écriture — l'enregistrement n'a pas pris effet",
            UiLocale::Es => "La entrada de inicio se leyó vacía después de escribirla: el registro no surtió efecto",
            UiLocale::De => "Der Autostart-Eintrag war nach dem Schreiben beim Rücklesen leer — die Registrierung ist nicht wirksam geworden",
            UiLocale::Ja => "自動起動エントリの書き込み後の読み戻しが空です——登録が反映されていません",
            UiLocale::Ko => "시작 프로그램 항목을 쓴 후 다시 읽으니 비어 있습니다 — 등록이 적용되지 않았습니다",
            UiLocale::Ru => "После записи запись автозапуска прочиталась пустой — регистрация не вступила в силу",
        },
        Msg::AutostartRecheckFailed => match locale {
            UiLocale::En => "Startup state re-check failed: {detail}",
            UiLocale::ZhCn => "开机自启状态复核失败：{detail}",
            UiLocale::ZhTw => "開機自動啟動狀態複查失敗：{detail}",
            UiLocale::Fr => "Échec de la nouvelle vérification de l'état de démarrage : {detail}",
            UiLocale::Es => "Falló la nueva comprobación del estado de inicio: {detail}",
            UiLocale::De => "Die erneute Prüfung des Autostart-Status ist fehlgeschlagen: {detail}",
            UiLocale::Ja => "自動起動状態の再確認に失敗しました：{detail}",
            UiLocale::Ko => "시작 프로그램 상태 재확인 실패: {detail}",
            UiLocale::Ru => "Не удалось повторно проверить состояние автозапуска: {detail}",
        },
        Msg::AutostartEnabledButOff => match locale {
            UiLocale::En => "The startup entry was written, but the system reports it as disabled (it may be turned off in Task Manager's Startup tab)",
            UiLocale::ZhCn => "开机自启项已写入，但系统层复核为未启用（可能被任务管理器启动项禁用）",
            UiLocale::ZhTw => "開機自動啟動項目已寫入，但系統層複查為未啟用（可能在工作管理員的「開機」索引標籤被停用）",
            UiLocale::Fr => "L'entrée de démarrage a été écrite, mais le système la signale comme désactivée (elle a pu être désactivée dans l'onglet Démarrage du Gestionnaire des tâches)",
            UiLocale::Es => "La entrada de inicio se escribió, pero el sistema la indica como desactivada (puede estar desactivada en la pestaña Inicio del Administrador de tareas)",
            UiLocale::De => "Der Autostart-Eintrag wurde geschrieben, das System meldet ihn aber als deaktiviert (er kann im Task-Manager unter „Autostart“ ausgeschaltet sein)",
            UiLocale::Ja => "自動起動エントリは書き込まれましたが、システム側では無効と報告されています（タスクマネージャーのスタートアップで無効化された可能性があります）",
            UiLocale::Ko => "시작 프로그램 항목은 기록되었지만 시스템에서는 비활성으로 보고됩니다(작업 관리자의 시작 프로그램 탭에서 꺼져 있을 수 있습니다)",
            UiLocale::Ru => "Запись автозапуска создана, но система сообщает, что он отключён (возможно, он выключен на вкладке «Автозагрузка» диспетчера задач)",
        },
        Msg::AutostartStillEnabled => match locale {
            UiLocale::En => "The system still reports autostart as enabled after removal — the removal did not take effect",
            UiLocale::ZhCn => "开机自启项删除后系统层仍报告启用——移除未生效",
            UiLocale::ZhTw => "開機自動啟動項目刪除後系統層仍回報為已啟用——移除未生效",
            UiLocale::Fr => "Après la suppression, le système signale toujours le démarrage automatique comme activé — la suppression n'a pas pris effet",
            UiLocale::Es => "Tras quitarla, el sistema sigue indicando el inicio automático como activado: la eliminación no surtió efecto",
            UiLocale::De => "Das System meldet den Autostart nach dem Entfernen weiterhin als aktiviert — das Entfernen ist nicht wirksam geworden",
            UiLocale::Ja => "削除後もシステムは自動起動が有効と報告しています——削除が反映されていません",
            UiLocale::Ko => "제거 후에도 시스템이 자동 시작이 활성 상태라고 보고합니다 — 제거가 적용되지 않았습니다",
            UiLocale::Ru => "После удаления система всё ещё сообщает, что автозапуск включён — удаление не вступило в силу",
        },
        Msg::AutostartRegOpenFailed => match locale {
            UiLocale::En => "Failed to open the startup registry key: {detail}",
            UiLocale::ZhCn => "打开启动项注册表键失败：{detail}",
            UiLocale::ZhTw => "開啟開機自動啟動的登錄檔機碼失敗：{detail}",
            UiLocale::Fr => "Échec de l'ouverture de la clé de registre de démarrage : {detail}",
            UiLocale::Es => "No se pudo abrir la clave del registro de inicio: {detail}",
            UiLocale::De => "Der Autostart-Registrierungsschlüssel konnte nicht geöffnet werden: {detail}",
            UiLocale::Ja => "スタートアップのレジストリキーを開けません：{detail}",
            UiLocale::Ko => "시작 프로그램 레지스트리 키 열기 실패: {detail}",
            UiLocale::Ru => "Не удалось открыть раздел реестра автозапуска: {detail}",
        },
        Msg::AutostartRewriteFailed => match locale {
            UiLocale::En => "Failed to rewrite the startup entry with a quoted path: {detail}",
            UiLocale::ZhCn => "自启项改写为带引号路径失败：{detail}",
            UiLocale::ZhTw => "自動啟動項目改寫為帶引號路徑失敗：{detail}",
            UiLocale::Fr => "Échec de la réécriture de l'entrée de démarrage avec un chemin entre guillemets : {detail}",
            UiLocale::Es => "No se pudo reescribir la entrada de inicio con la ruta entre comillas: {detail}",
            UiLocale::De => "Der Autostart-Eintrag konnte nicht mit einem Pfad in Anführungszeichen neu geschrieben werden: {detail}",
            UiLocale::Ja => "自動起動エントリを引用符付きパスに書き換えられません：{detail}",
            UiLocale::Ko => "시작 프로그램 항목을 따옴표 있는 경로로 다시 쓰기 실패: {detail}",
            UiLocale::Ru => "Не удалось перезаписать запись автозапуска с путём в кавычках: {detail}",
        },
    }
}
