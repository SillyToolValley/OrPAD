// Supplemental translations for beta UI surfaces whose keys do not exist in
// the older locale JSON packs yet. Existing locale JSON values still win.
const packs = {
  zh: {
    terminal: '终端', terminalSubtitle: '集成 Shell、Runner 和 AI 助手', newTerminal: '新建终端', chooseShell: '选择 Shell 配置', noTerminal: '没有正在运行的终端', startApproved: '点击 + 或选择 Shell 配置，在已授权工作区中启动。', terminalWindow: 'OrPAD 终端', loadingWorkspace: '正在加载工作区...', dockMain: '停靠到主窗口', noWorkspace: '尚无已授权工作区',
  },
  'zh-TW': {
    terminal: '終端機', terminalSubtitle: '整合 Shell、Runner 與 AI 助手', newTerminal: '新增終端機', chooseShell: '選擇 Shell 設定檔', noTerminal: '沒有執行中的終端機', startApproved: '按 + 或選擇 Shell 設定檔，在已授權工作區啟動。', terminalWindow: 'OrPAD 終端機', loadingWorkspace: '正在載入工作區...', dockMain: '停靠到主視窗', noWorkspace: '尚無已授權工作區',
  },
  ja: {
    terminal: 'ターミナル', terminalSubtitle: '統合シェル、Runner、AI ヘルパー', newTerminal: '新しいターミナル', chooseShell: 'シェルプロファイルを選択', noTerminal: '実行中のターミナルはありません', startApproved: '+ をクリックするかシェルプロファイルを選択して、承認済みワークスペースで開始します。', terminalWindow: 'OrPAD ターミナル', loadingWorkspace: 'ワークスペースを読み込み中...', dockMain: 'メインにドッキング', noWorkspace: '承認済みワークスペースはまだありません',
  },
  es: {
    terminal: 'Terminal', terminalSubtitle: 'Shell integrado, Runner y asistentes de IA', newTerminal: 'Nuevo terminal', chooseShell: 'Elige un perfil de shell', noTerminal: 'No hay terminal en ejecución', startApproved: 'Haz clic en + o elige un perfil de shell para iniciar en el workspace aprobado.', terminalWindow: 'Terminal de OrPAD', loadingWorkspace: 'Cargando workspace...', dockMain: 'Acoplar a la ventana principal', noWorkspace: 'Aún no hay workspace aprobado',
  },
  fr: {
    terminal: 'Terminal', terminalSubtitle: 'Shell intégré, Runner et assistants IA', newTerminal: 'Nouveau terminal', chooseShell: 'Choisir un profil shell', noTerminal: 'Aucun terminal en cours', startApproved: 'Cliquez sur + ou choisissez un profil shell pour démarrer dans l’espace de travail approuvé.', terminalWindow: 'Terminal OrPAD', loadingWorkspace: 'Chargement de l’espace de travail...', dockMain: 'Ancrer à la fenêtre principale', noWorkspace: 'Aucun espace de travail approuvé',
  },
  de: {
    terminal: 'Terminal', terminalSubtitle: 'Integrierte Shell, Runner und KI-Helfer', newTerminal: 'Neues Terminal', chooseShell: 'Shell-Profil auswählen', noTerminal: 'Kein Terminal läuft', startApproved: 'Klicke auf + oder wähle ein Shell-Profil, um im freigegebenen Workspace zu starten.', terminalWindow: 'OrPAD Terminal', loadingWorkspace: 'Workspace wird geladen...', dockMain: 'An Hauptfenster andocken', noWorkspace: 'Noch kein freigegebener Workspace',
  },
  pt: {
    terminal: 'Terminal', terminalSubtitle: 'Shell integrada, Runner e assistentes de IA', newTerminal: 'Novo terminal', chooseShell: 'Escolha um perfil de shell', noTerminal: 'Nenhum terminal em execução', startApproved: 'Clique em + ou escolha um perfil de shell para iniciar no workspace aprovado.', terminalWindow: 'Terminal do OrPAD', loadingWorkspace: 'Carregando workspace...', dockMain: 'Acoplar à janela principal', noWorkspace: 'Nenhum workspace aprovado ainda',
  },
  ru: {
    terminal: 'Терминал', terminalSubtitle: 'Встроенная shell, Runner и AI-помощники', newTerminal: 'Новый терминал', chooseShell: 'Выберите профиль shell', noTerminal: 'Нет запущенного терминала', startApproved: 'Нажмите + или выберите профиль shell для запуска в разрешённой рабочей области.', terminalWindow: 'Терминал OrPAD', loadingWorkspace: 'Загрузка рабочей области...', dockMain: 'Закрепить в главном окне', noWorkspace: 'Разрешённой рабочей области пока нет',
  },
  it: {
    terminal: 'Terminale', terminalSubtitle: 'Shell integrata, Runner e assistenti IA', newTerminal: 'Nuovo terminale', chooseShell: 'Scegli un profilo shell', noTerminal: 'Nessun terminale in esecuzione', startApproved: 'Fai clic su + o scegli un profilo shell per avviare nel workspace approvato.', terminalWindow: 'Terminale OrPAD', loadingWorkspace: 'Caricamento workspace...', dockMain: 'Aggancia alla finestra principale', noWorkspace: 'Nessun workspace approvato',
  },
  ar: {
    terminal: 'الطرفية', terminalSubtitle: 'Shell مدمج وRunner ومساعدو AI', newTerminal: 'طرفية جديدة', chooseShell: 'اختر ملف Shell', noTerminal: 'لا توجد طرفية قيد التشغيل', startApproved: 'انقر + أو اختر ملف Shell للبدء داخل مساحة العمل المعتمدة.', terminalWindow: 'طرفية OrPAD', loadingWorkspace: 'جار تحميل مساحة العمل...', dockMain: 'إرساء في النافذة الرئيسية', noWorkspace: 'لا توجد مساحة عمل معتمدة بعد',
  },
  hi: {
    terminal: 'टर्मिनल', terminalSubtitle: 'एकीकृत Shell, Runner और AI सहायक', newTerminal: 'नया टर्मिनल', chooseShell: 'Shell प्रोफाइल चुनें', noTerminal: 'कोई टर्मिनल चालू नहीं है', startApproved: '+ क्लिक करें या स्वीकृत workspace में शुरू करने के लिए Shell प्रोफाइल चुनें।', terminalWindow: 'OrPAD टर्मिनल', loadingWorkspace: 'Workspace लोड हो रहा है...', dockMain: 'मुख्य विंडो में डॉक करें', noWorkspace: 'अभी कोई स्वीकृत workspace नहीं है',
  },
  nl: {
    terminal: 'Terminal', terminalSubtitle: 'Geïntegreerde shell, Runner en AI-helpers', newTerminal: 'Nieuwe terminal', chooseShell: 'Kies een shellprofiel', noTerminal: 'Geen terminal actief', startApproved: 'Klik op + of kies een shellprofiel om te starten in de goedgekeurde workspace.', terminalWindow: 'OrPAD Terminal', loadingWorkspace: 'Workspace laden...', dockMain: 'Dock aan hoofdvenster', noWorkspace: 'Nog geen goedgekeurde workspace',
  },
  pl: {
    terminal: 'Terminal', terminalSubtitle: 'Zintegrowana shell, Runner i pomocnicy AI', newTerminal: 'Nowy terminal', chooseShell: 'Wybierz profil shell', noTerminal: 'Brak uruchomionego terminala', startApproved: 'Kliknij + lub wybierz profil shell, aby uruchomić w zatwierdzonym workspace.', terminalWindow: 'Terminal OrPAD', loadingWorkspace: 'Ładowanie workspace...', dockMain: 'Zadokuj w głównym oknie', noWorkspace: 'Brak zatwierdzonego workspace',
  },
  tr: {
    terminal: 'Terminal', terminalSubtitle: 'Entegre Shell, Runner ve AI yardımcıları', newTerminal: 'Yeni terminal', chooseShell: 'Shell profili seç', noTerminal: 'Çalışan terminal yok', startApproved: 'Onaylı workspace içinde başlatmak için + düğmesine tıklayın veya Shell profili seçin.', terminalWindow: 'OrPAD Terminal', loadingWorkspace: 'Workspace yükleniyor...', dockMain: 'Ana pencereye yerleştir', noWorkspace: 'Henüz onaylı workspace yok',
  },
  vi: {
    terminal: 'Terminal', terminalSubtitle: 'Shell tích hợp, Runner và trợ lý AI', newTerminal: 'Terminal mới', chooseShell: 'Chọn hồ sơ Shell', noTerminal: 'Không có terminal đang chạy', startApproved: 'Bấm + hoặc chọn hồ sơ Shell để bắt đầu trong workspace đã được duyệt.', terminalWindow: 'Terminal OrPAD', loadingWorkspace: 'Đang tải workspace...', dockMain: 'Gắn vào cửa sổ chính', noWorkspace: 'Chưa có workspace được duyệt',
  },
  th: {
    terminal: 'เทอร์มินัล', terminalSubtitle: 'Shell รวม, Runner และผู้ช่วย AI', newTerminal: 'เทอร์มินัลใหม่', chooseShell: 'เลือกโปรไฟล์ Shell', noTerminal: 'ไม่มีเทอร์มินัลที่กำลังทำงาน', startApproved: 'คลิก + หรือเลือกโปรไฟล์ Shell เพื่อเริ่มใน workspace ที่อนุมัติแล้ว', terminalWindow: 'เทอร์มินัล OrPAD', loadingWorkspace: 'กำลังโหลด workspace...', dockMain: 'Dock ไปยังหน้าต่างหลัก', noWorkspace: 'ยังไม่มี workspace ที่อนุมัติ',
  },
  sv: {
    terminal: 'Terminal', terminalSubtitle: 'Integrerat shell, Runner och AI-hjälpare', newTerminal: 'Ny terminal', chooseShell: 'Välj shellprofil', noTerminal: 'Ingen terminal körs', startApproved: 'Klicka på + eller välj en shellprofil för att starta i godkänd workspace.', terminalWindow: 'OrPAD Terminal', loadingWorkspace: 'Läser in workspace...', dockMain: 'Docka till huvudfönster', noWorkspace: 'Ingen godkänd workspace ännu',
  },
  da: {
    terminal: 'Terminal', terminalSubtitle: 'Integreret shell, Runner og AI-hjælpere', newTerminal: 'Ny terminal', chooseShell: 'Vælg shellprofil', noTerminal: 'Ingen terminal kører', startApproved: 'Klik + eller vælg en shellprofil for at starte i godkendt workspace.', terminalWindow: 'OrPAD Terminal', loadingWorkspace: 'Indlæser workspace...', dockMain: 'Dock til hovedvindue', noWorkspace: 'Ingen godkendt workspace endnu',
  },
  fi: {
    terminal: 'Pääte', terminalSubtitle: 'Integroitu shell, Runner ja AI-avustajat', newTerminal: 'Uusi pääte', chooseShell: 'Valitse shell-profiili', noTerminal: 'Päätettä ei ole käynnissä', startApproved: 'Napsauta + tai valitse shell-profiili käynnistääksesi hyväksytyssä workspacessa.', terminalWindow: 'OrPAD-pääte', loadingWorkspace: 'Ladataan workspacea...', dockMain: 'Telakoi pääikkunaan', noWorkspace: 'Hyväksyttyä workspacea ei vielä ole',
  },
  nb: {
    terminal: 'Terminal', terminalSubtitle: 'Integrert shell, Runner og AI-hjelpere', newTerminal: 'Ny terminal', chooseShell: 'Velg shellprofil', noTerminal: 'Ingen terminal kjører', startApproved: 'Klikk + eller velg en shellprofil for å starte i godkjent workspace.', terminalWindow: 'OrPAD Terminal', loadingWorkspace: 'Laster workspace...', dockMain: 'Dock til hovedvindu', noWorkspace: 'Ingen godkjent workspace ennå',
  },
  cs: {
    terminal: 'Terminál', terminalSubtitle: 'Integrovaný shell, Runner a AI asistenti', newTerminal: 'Nový terminál', chooseShell: 'Vyberte profil shellu', noTerminal: 'Neběží žádný terminál', startApproved: 'Klikněte na + nebo vyberte profil shellu pro spuštění ve schváleném workspace.', terminalWindow: 'Terminál OrPAD', loadingWorkspace: 'Načítání workspace...', dockMain: 'Ukotvit do hlavního okna', noWorkspace: 'Zatím žádný schválený workspace',
  },
  el: {
    terminal: 'Τερματικό', terminalSubtitle: 'Ενσωματωμένο Shell, Runner και βοηθοί AI', newTerminal: 'Νέο τερματικό', chooseShell: 'Επιλέξτε προφίλ Shell', noTerminal: 'Δεν εκτελείται τερματικό', startApproved: 'Κάντε κλικ στο + ή επιλέξτε προφίλ Shell για εκκίνηση στο εγκεκριμένο workspace.', terminalWindow: 'Τερματικό OrPAD', loadingWorkspace: 'Φόρτωση workspace...', dockMain: 'Προσάρτηση στο κύριο παράθυρο', noWorkspace: 'Δεν υπάρχει ακόμη εγκεκριμένο workspace',
  },
  hu: {
    terminal: 'Terminál', terminalSubtitle: 'Integrált shell, Runner és AI-segédek', newTerminal: 'Új terminál', chooseShell: 'Shell-profil kiválasztása', noTerminal: 'Nem fut terminál', startApproved: 'Kattints a + gombra vagy válassz shell-profilt az engedélyezett workspace-ben indításhoz.', terminalWindow: 'OrPAD Terminál', loadingWorkspace: 'Workspace betöltése...', dockMain: 'Dokkolás a főablakba', noWorkspace: 'Még nincs engedélyezett workspace',
  },
  ro: {
    terminal: 'Terminal', terminalSubtitle: 'Shell integrat, Runner și asistenți AI', newTerminal: 'Terminal nou', chooseShell: 'Alege un profil shell', noTerminal: 'Nu rulează niciun terminal', startApproved: 'Apasă + sau alege un profil shell pentru a porni în workspace-ul aprobat.', terminalWindow: 'Terminal OrPAD', loadingWorkspace: 'Se încarcă workspace-ul...', dockMain: 'Andochează în fereastra principală', noWorkspace: 'Niciun workspace aprobat încă',
  },
  uk: {
    terminal: 'Термінал', terminalSubtitle: 'Вбудована shell, Runner і AI-помічники', newTerminal: 'Новий термінал', chooseShell: 'Виберіть профіль shell', noTerminal: 'Немає запущеного термінала', startApproved: 'Натисніть + або виберіть профіль shell для запуску в дозволеному workspace.', terminalWindow: 'Термінал OrPAD', loadingWorkspace: 'Завантаження workspace...', dockMain: 'Закріпити в головному вікні', noWorkspace: 'Дозволеного workspace ще немає',
  },
  id: {
    terminal: 'Terminal', terminalSubtitle: 'Shell terintegrasi, Runner, dan asisten AI', newTerminal: 'Terminal baru', chooseShell: 'Pilih profil Shell', noTerminal: 'Tidak ada terminal berjalan', startApproved: 'Klik + atau pilih profil Shell untuk memulai di workspace yang disetujui.', terminalWindow: 'Terminal OrPAD', loadingWorkspace: 'Memuat workspace...', dockMain: 'Dock ke jendela utama', noWorkspace: 'Belum ada workspace yang disetujui',
  },
  ms: {
    terminal: 'Terminal', terminalSubtitle: 'Shell bersepadu, Runner dan pembantu AI', newTerminal: 'Terminal baharu', chooseShell: 'Pilih profil Shell', noTerminal: 'Tiada terminal berjalan', startApproved: 'Klik + atau pilih profil Shell untuk bermula dalam workspace yang diluluskan.', terminalWindow: 'Terminal OrPAD', loadingWorkspace: 'Memuatkan workspace...', dockMain: 'Dock ke tetingkap utama', noWorkspace: 'Belum ada workspace diluluskan',
  },
  he: {
    terminal: 'מסוף', terminalSubtitle: 'Shell משולב, Runner ועוזרי AI', newTerminal: 'מסוף חדש', chooseShell: 'בחר פרופיל Shell', noTerminal: 'אין מסוף פעיל', startApproved: 'לחץ + או בחר פרופיל Shell כדי להתחיל ב-workspace מאושר.', terminalWindow: 'מסוף OrPAD', loadingWorkspace: 'טוען workspace...', dockMain: 'הצמד לחלון הראשי', noWorkspace: 'עדיין אין workspace מאושר',
  },
};

const aliases = {};

function fromPack(p) {
  return {
    'terminal.title': p.terminal,
    'terminal.subtitle': p.terminalSubtitle,
    'terminal.mode.terminal': p.terminal,
    'terminal.new.title': p.newTerminal,
    'terminal.new.subtitle': p.chooseShell,
    'terminal.empty.title': p.noTerminal,
    'terminal.empty.subtitle': p.startApproved,
    'terminal.window.title': p.terminalWindow,
    'terminal.window.loadingWorkspace': p.loadingWorkspace,
    'terminal.window.dockToMain': p.dockMain,
    'terminal.window.noWorkspace': p.noWorkspace,
  };
}

export const extraLocales = {};
for (const [code, pack] of Object.entries({ ...packs, ...aliases })) {
  if (pack) extraLocales[code] = fromPack(pack);
}
