/**
 * What the panel says, in the language the viewer reads.
 *
 * The English text is the key. That keeps the code readable — a call site says
 * what it will show rather than an identifier that has to be looked up — and it
 * means English needs no dictionary at all, which is also the fallback when a
 * translation is missing. A test holds the other half of the bargain: every
 * dictionary key must exist in the source, or a renamed English string would
 * silently drop four languages back to English.
 *
 * Only the interface is translated. Everything the machine writes — the
 * diagnostics log, the developer report, the shared log file — stays English,
 * because it is read by whoever is fixing the thing rather than by the viewer.
 */

//: Values are substituted as {name}, so a translation can put them wherever its
//: grammar needs them rather than where English happened to.
const FILL = /\{(\w+)\}/g;

const UK = {
  // Archive
  "Pick a day and press Show.": "Оберіть день і натисніть «Показати».",
  "Looking for recordings…": "Шукаю записи…",
  "Show": "Показати",
  "channel {channel}": "канал {channel}",
  "back 10 s": "назад на 10 с",
  "forward 10 s": "вперед на 10 с",
  "  (really ×{rate})": "  (фактично ×{rate})",
  "Nothing recorded on {day}.": "За {day} записів немає.",
  "Click the bar to play from that moment.": "Клацніть по шкалі, щоб почати відтворення з цього моменту.",
  "Total: {count}": "Усього: {count}",
  "Start": "Початок",
  "End": "Кінець",
  "Event": "Подія",
  "Size": "Розмір",
  "File": "Файл",
  "Showing the first 300 of {count}.": "Показано перші 300 із {count}.",
  "On schedule": "За розкладом",
  "Alarm": "Тривога",
  "Manual": "Вручну",

  // Configuration browser
  "Read the configuration": "Прочитати конфігурацію",
  "Reading the configuration tree…": "Читаю дерево конфігурації…",
  "Pick a section on the left.": "Оберіть секцію ліворуч.",
  "Reading…": "Читаю…",

  // The shared log card
  "Shared log": "Спільний журнал",
  "The panel and the server write into one file, {file}, beside the Home Assistant configuration, on one clock counted from the page load. That shows the order of events lasting fractions of a second — why a tile blinked on refresh, for instance.": "Панель і серверна частина пишуть в один файл {file} поруч із конфігурацією Home Assistant, за спільним відліком часу від завантаження сторінки. Так видно послідовність подій, що тривають частки секунди — наприклад, чому плитка блимнула при оновленні.",
  "Off by default, and nothing is sent anywhere.": "Вимкнено за замовчуванням, нічого нікуди не надсилається.",
  "Recording — reload the page to capture a start.": "Запис триває — оновіть сторінку, щоб зафіксувати запуск.",
  "Stop recording": "Зупинити запис",
  "Start recording": "Почати запис",
  "Show the file": "Показати файл",
  "The file is empty.": "Файл порожній.",
  "Could not read it: {error}": "Не вдалося прочитати: {error}",

  // Developer report
  "Developer report": "Звіт для розробника",
  "Collects the model, the firmware, what the recorder can do, the encoder settings and the state of the player — what is needed to understand how your particular device behaves.": "Збирає модель, прошивку, перелік можливостей реєстратора, налаштування кодування та стан програвача — те, що потрібно, щоб зрозуміти поведінку саме вашого пристрою.",
  "Passwords, hashes, serial numbers, MAC and IP addresses are stripped automatically. The report is not sent anywhere by itself — you copy it or open an issue.": "Паролі, хеші, серійні номери, MAC- та IP-адреси вирізаються автоматично. Звіт нікуди не надсилається сам — ви його копіюєте або відкриваєте issue.",
  "Build the report": "Зібрати звіт",
  "Building…": "Збираю…",
  "Copy": "Копіювати",
  "Download .md": "Завантажити .md",
  "Open an issue on GitHub": "Створити issue на GitHub",
  "Refresh": "Оновити",
  "Could not build the report: {error}": "Не вдалося зібрати звіт: {error}",

  // Recorder log
  "Read the log": "Прочитати журнал",
  "Reading the log…": "Читаю журнал…",
  "The log is empty.": "Журнал порожній.",
  "Time": "Час",
  "User": "Користувач",
  "Details": "Деталі",
  // Three forms where English has two: 1 канал, 2–4 канали, 5+ каналів, and
  // the teens go back to the last form whatever their final digit says.
  "{count} channels": ({ count }) => {
    const tail = count % 10;
    const teen = count % 100 >= 11 && count % 100 <= 14;
    if (!teen && tail === 1) return "{count} канал";
    if (!teen && tail >= 2 && tail <= 4) return "{count} канали";
    return "{count} каналів";
  },
  // Shell and tabs
  "Overview": "Огляд",
  "Channels": "Канали",
  "Archive": "Архів",
  "Configuration": "Конфігурація",
  "Settings": "Налаштування",
  "Log": "Журнал",
  "Report": "Звіт",
  "Loading…": "Завантаження…",
  "No data": "Немає даних",
  "No recorder is configured.": "Жодного реєстратора не налаштовано.",

  // Header facts
  "Stream": "Потік",
  "Disk": "Диск",
  "Uptime": "Працює",
  "recording: {count}": "запис: {count}",
  "to {day}": "по {day}",

  // The wall
  "{shown} of {total} channels on the wall": "{shown} з {total} каналів на стіні",
  "Fullscreen (Esc to leave)": "На весь екран (вихід — Esc)",
  "Wall channels": "Канали стіни",
  "On the wall, camera online": "На стіні, канал онлайн",
  "On the wall, camera offline": "На стіні, канал офлайн",
  "Not on the wall": "Не на стіні",
  "Drag the row to reorder": "Перетягніть рядок, щоб змінити порядок",
  "Stream of this camera on the wall": "Потік цієї камери на стіні",
  "connecting…": "підключення…",
  "offline": "офлайн",
  "could not decode": "не вдалося декодувати",
  "no address for the stream": "немає адреси для потоку",
  "attempt {attempt} in {seconds}s": "спроба {attempt} через {seconds}с",
  "could not be recovered": "відновити не вдалося",
  "the camera sends no video": "камера не передає відео",
  "the recorder cut the stream": "реєстратор обірвав потік",
  "connection to the recorder failed": "збій зв'язку з реєстратором",

  // Badges and the channel table
  "recording": "запис",
  "motion": "рух",
  "no signal": "немає сигналу",
  "No frame": "Немає кадру",
  "Offline": "Офлайн",
  "Name": "Назва",
  "State": "Стан",
  "Resolution": "Роздільність",
  "Bitrate": "Бітрейт",
  "Recording": "Запис",
  "Motion": "Рух",
  "Connected": "Підключено",
  "yes": "так",
  "{kbps} kbit/s": "{kbps} кбіт/с",

  // Streams and players
  "Sub": "Дод.",
  "Main": "Осн.",
  "Native (WebCodecs)": "Нативний (WebCodecs)",
  "Snapshots": "Стоп-кадри",
  "{reason}. Switched to the sub stream.": "{reason}. Перейшов на додатковий потік.",
  "{reason}. Switched to snapshots.": "{reason}. Перейшов на стоп-кадри.",

  // Units and durations
  "{days}d {hours}h": "{days} дн {hours} год",
  "{hours}h {minutes}m": "{hours} год {minutes} хв",
  "{minutes}m": "{minutes} хв",
  "{value} Mbit/s": "{value} Мбіт/с",
  "B": "Б",
  "KB": "КБ",
  "MB": "МБ",
  "GB": "ГБ",
  "TB": "ТБ",
};

const ES = {
  "Pick a day and press Show.": "Elige un día y pulsa Mostrar.",
  "Looking for recordings…": "Buscando grabaciones…",
  "Show": "Mostrar",
  "channel {channel}": "canal {channel}",
  "back 10 s": "10 s atrás",
  "forward 10 s": "10 s adelante",
  "  (really ×{rate})": "  (real ×{rate})",
  "Nothing recorded on {day}.": "No hay grabaciones del {day}.",
  "Click the bar to play from that moment.": "Haz clic en la barra para reproducir desde ese momento.",
  "Total: {count}": "Total: {count}",
  "Start": "Inicio",
  "End": "Fin",
  "Event": "Evento",
  "Size": "Tamaño",
  "File": "Archivo",
  "Showing the first 300 of {count}.": "Se muestran las primeras 300 de {count}.",
  "On schedule": "Por programación",
  "Alarm": "Alarma",
  "Manual": "Manual",

  "Read the configuration": "Leer la configuración",
  "Reading the configuration tree…": "Leyendo el árbol de configuración…",
  "Pick a section on the left.": "Elige una sección a la izquierda.",
  "Reading…": "Leyendo…",

  "Shared log": "Registro compartido",
  "The panel and the server write into one file, {file}, beside the Home Assistant configuration, on one clock counted from the page load. That shows the order of events lasting fractions of a second — why a tile blinked on refresh, for instance.": "El panel y el servidor escriben en un mismo archivo, {file}, junto a la configuración de Home Assistant, con un único reloj contado desde la carga de la página. Así se ve el orden de sucesos que duran fracciones de segundo — por ejemplo, por qué parpadeó un mosaico al recargar.",
  "Off by default, and nothing is sent anywhere.": "Desactivado por defecto, y no se envía nada a ninguna parte.",
  "Recording — reload the page to capture a start.": "Grabando: recarga la página para capturar un arranque.",
  "Stop recording": "Detener la grabación",
  "Start recording": "Empezar a grabar",
  "Show the file": "Mostrar el archivo",
  "The file is empty.": "El archivo está vacío.",
  "Could not read it: {error}": "No se pudo leer: {error}",

  "Developer report": "Informe para el desarrollador",
  "Collects the model, the firmware, what the recorder can do, the encoder settings and the state of the player — what is needed to understand how your particular device behaves.": "Reúne el modelo, el firmware, lo que puede hacer el grabador, los ajustes del codificador y el estado del reproductor: lo necesario para entender cómo se comporta tu dispositivo concreto.",
  "Passwords, hashes, serial numbers, MAC and IP addresses are stripped automatically. The report is not sent anywhere by itself — you copy it or open an issue.": "Las contraseñas, los hashes, los números de serie y las direcciones MAC e IP se eliminan automáticamente. El informe no se envía solo a ninguna parte: tú lo copias o abres una incidencia.",
  "Build the report": "Generar el informe",
  "Building…": "Generando…",
  "Copy": "Copiar",
  "Download .md": "Descargar .md",
  "Open an issue on GitHub": "Abrir una incidencia en GitHub",
  "Refresh": "Actualizar",
  "Could not build the report: {error}": "No se pudo generar el informe: {error}",

  "Read the log": "Leer el registro",
  "Reading the log…": "Leyendo el registro…",
  "The log is empty.": "El registro está vacío.",
  "Time": "Hora",
  "User": "Usuario",
  "Details": "Detalles",
  "{count} channels": ({ count }) => (count === 1 ? "{count} canal" : "{count} canales"),
  "Overview": "Vista general",
  "Channels": "Canales",
  "Archive": "Archivo",
  "Configuration": "Configuración",
  "Settings": "Ajustes",
  "Log": "Registro",
  "Report": "Informe",
  "Loading…": "Cargando…",
  "No data": "Sin datos",
  "No recorder is configured.": "No hay ningún grabador configurado.",

  "Stream": "Flujo",
  "Disk": "Disco",
  "Uptime": "Activo",
  "recording: {count}": "grabando: {count}",
  "to {day}": "hasta {day}",

  "{shown} of {total} channels on the wall": "{shown} de {total} canales en el mosaico",
  "Fullscreen (Esc to leave)": "Pantalla completa (Esc para salir)",
  "Wall channels": "Canales del mosaico",
  "On the wall, camera online": "En el mosaico, cámara en línea",
  "On the wall, camera offline": "En el mosaico, cámara desconectada",
  "Not on the wall": "Fuera del mosaico",
  "Drag the row to reorder": "Arrastra la fila para reordenar",
  "Stream of this camera on the wall": "Flujo de esta cámara en el mosaico",
  "connecting…": "conectando…",
  "offline": "sin conexión",
  "could not decode": "no se pudo decodificar",
  "no address for the stream": "sin dirección para el flujo",
  "attempt {attempt} in {seconds}s": "intento {attempt} en {seconds} s",
  "could not be recovered": "no se pudo recuperar",
  "the camera sends no video": "la cámara no envía vídeo",
  "the recorder cut the stream": "el grabador cortó el flujo",
  "connection to the recorder failed": "fallo de conexión con el grabador",

  "recording": "grabando",
  "motion": "movimiento",
  "no signal": "sin señal",
  "No frame": "Sin imagen",
  "Offline": "Sin conexión",
  "Name": "Nombre",
  "State": "Estado",
  "Resolution": "Resolución",
  "Bitrate": "Tasa de bits",
  "Recording": "Grabando",
  "Motion": "Movimiento",
  "Connected": "Conectado",
  "yes": "sí",
  "{kbps} kbit/s": "{kbps} kbit/s",

  "Sub": "Sec.",
  "Main": "Prin.",
  "Native (WebCodecs)": "Nativo (WebCodecs)",
  "Snapshots": "Instantáneas",
  "{reason}. Switched to the sub stream.": "{reason}. Se cambió al flujo secundario.",
  "{reason}. Switched to snapshots.": "{reason}. Se cambió a instantáneas.",

  "{days}d {hours}h": "{days} d {hours} h",
  "{hours}h {minutes}m": "{hours} h {minutes} min",
  "{minutes}m": "{minutes} min",
  "{value} Mbit/s": "{value} Mbit/s",
  "B": "B",
  "KB": "KB",
  "MB": "MB",
  "GB": "GB",
  "TB": "TB",
};

const FR = {
  "Pick a day and press Show.": "Choisissez un jour et appuyez sur Afficher.",
  "Looking for recordings…": "Recherche des enregistrements…",
  "Show": "Afficher",
  "channel {channel}": "canal {channel}",
  "back 10 s": "10 s en arrière",
  "forward 10 s": "10 s en avant",
  "  (really ×{rate})": "  (réel ×{rate})",
  "Nothing recorded on {day}.": "Aucun enregistrement le {day}.",
  "Click the bar to play from that moment.": "Cliquez sur la barre pour lire à partir de ce moment.",
  "Total: {count}": "Total : {count}",
  "Start": "Début",
  "End": "Fin",
  "Event": "Événement",
  "Size": "Taille",
  "File": "Fichier",
  "Showing the first 300 of {count}.": "Les 300 premiers sur {count} sont affichés.",
  "On schedule": "Planifié",
  "Alarm": "Alarme",
  "Manual": "Manuel",

  "Read the configuration": "Lire la configuration",
  "Reading the configuration tree…": "Lecture de l'arborescence de configuration…",
  "Pick a section on the left.": "Choisissez une section à gauche.",
  "Reading…": "Lecture…",

  "Shared log": "Journal commun",
  "The panel and the server write into one file, {file}, beside the Home Assistant configuration, on one clock counted from the page load. That shows the order of events lasting fractions of a second — why a tile blinked on refresh, for instance.": "Le panneau et le serveur écrivent dans un même fichier, {file}, à côté de la configuration de Home Assistant, sur une seule horloge comptée depuis le chargement de la page. On voit ainsi l'ordre d'événements qui durent des fractions de seconde — par exemple pourquoi une tuile a clignoté au rechargement.",
  "Off by default, and nothing is sent anywhere.": "Désactivé par défaut, et rien n'est envoyé nulle part.",
  "Recording — reload the page to capture a start.": "Enregistrement en cours — rechargez la page pour capturer un démarrage.",
  "Stop recording": "Arrêter l'enregistrement",
  "Start recording": "Démarrer l'enregistrement",
  "Show the file": "Afficher le fichier",
  "The file is empty.": "Le fichier est vide.",
  "Could not read it: {error}": "Lecture impossible : {error}",

  "Developer report": "Rapport pour le développeur",
  "Collects the model, the firmware, what the recorder can do, the encoder settings and the state of the player — what is needed to understand how your particular device behaves.": "Rassemble le modèle, le firmware, ce dont l'enregistreur est capable, les réglages d'encodage et l'état du lecteur — ce qu'il faut pour comprendre le comportement de votre appareil précis.",
  "Passwords, hashes, serial numbers, MAC and IP addresses are stripped automatically. The report is not sent anywhere by itself — you copy it or open an issue.": "Les mots de passe, empreintes, numéros de série et adresses MAC et IP sont retirés automatiquement. Le rapport n'est envoyé nulle part de lui-même : vous le copiez ou ouvrez un ticket.",
  "Build the report": "Générer le rapport",
  "Building…": "Génération…",
  "Copy": "Copier",
  "Download .md": "Télécharger .md",
  "Open an issue on GitHub": "Ouvrir un ticket sur GitHub",
  "Refresh": "Actualiser",
  "Could not build the report: {error}": "Impossible de générer le rapport : {error}",

  "Read the log": "Lire le journal",
  "Reading the log…": "Lecture du journal…",
  "The log is empty.": "Le journal est vide.",
  "Time": "Heure",
  "User": "Utilisateur",
  "Details": "Détails",
  "{count} channels": ({ count }) => (count === 1 ? "{count} canal" : "{count} canaux"),
  "Overview": "Vue d'ensemble",
  "Channels": "Canaux",
  "Archive": "Archive",
  "Configuration": "Configuration",
  "Settings": "Réglages",
  "Log": "Journal",
  "Report": "Rapport",
  "Loading…": "Chargement…",
  "No data": "Aucune donnée",
  "No recorder is configured.": "Aucun enregistreur n'est configuré.",

  "Stream": "Flux",
  "Disk": "Disque",
  "Uptime": "En marche",
  "recording: {count}": "enregistrement : {count}",
  "to {day}": "jusqu'au {day}",

  "{shown} of {total} channels on the wall": "{shown} sur {total} canaux au mur",
  "Fullscreen (Esc to leave)": "Plein écran (Échap pour sortir)",
  "Wall channels": "Canaux du mur",
  "On the wall, camera online": "Au mur, caméra en ligne",
  "On the wall, camera offline": "Au mur, caméra hors ligne",
  "Not on the wall": "Pas au mur",
  "Drag the row to reorder": "Faites glisser la ligne pour réordonner",
  "Stream of this camera on the wall": "Flux de cette caméra au mur",
  "connecting…": "connexion…",
  "offline": "hors ligne",
  "could not decode": "décodage impossible",
  "no address for the stream": "pas d'adresse pour le flux",
  "attempt {attempt} in {seconds}s": "tentative {attempt} dans {seconds} s",
  "could not be recovered": "impossible à rétablir",
  "the camera sends no video": "la caméra n'envoie pas de vidéo",
  "the recorder cut the stream": "l'enregistreur a coupé le flux",
  "connection to the recorder failed": "échec de la liaison avec l'enregistreur",

  "recording": "enregistre",
  "motion": "mouvement",
  "no signal": "pas de signal",
  "No frame": "Pas d'image",
  "Offline": "Hors ligne",
  "Name": "Nom",
  "State": "État",
  "Resolution": "Résolution",
  "Bitrate": "Débit",
  "Recording": "Enregistrement",
  "Motion": "Mouvement",
  "Connected": "Connecté",
  "yes": "oui",
  "{kbps} kbit/s": "{kbps} kbit/s",

  "Sub": "Sec.",
  "Main": "Prin.",
  "Native (WebCodecs)": "Natif (WebCodecs)",
  "Snapshots": "Instantanés",
  "{reason}. Switched to the sub stream.": "{reason}. Passage au flux secondaire.",
  "{reason}. Switched to snapshots.": "{reason}. Passage aux instantanés.",

  "{days}d {hours}h": "{days} j {hours} h",
  "{hours}h {minutes}m": "{hours} h {minutes} min",
  "{minutes}m": "{minutes} min",
  "{value} Mbit/s": "{value} Mbit/s",
  "B": "o",
  "KB": "Ko",
  "MB": "Mo",
  "GB": "Go",
  "TB": "To",
};

const DE = {
  "Pick a day and press Show.": "Wähle einen Tag und drücke Anzeigen.",
  "Looking for recordings…": "Suche nach Aufnahmen…",
  "Show": "Anzeigen",
  "channel {channel}": "Kanal {channel}",
  "back 10 s": "10 s zurück",
  "forward 10 s": "10 s vor",
  "  (really ×{rate})": "  (tatsächlich ×{rate})",
  "Nothing recorded on {day}.": "Keine Aufnahmen am {day}.",
  "Click the bar to play from that moment.": "Klicke auf den Balken, um ab diesem Moment abzuspielen.",
  "Total: {count}": "Gesamt: {count}",
  "Start": "Beginn",
  "End": "Ende",
  "Event": "Ereignis",
  "Size": "Größe",
  "File": "Datei",
  "Showing the first 300 of {count}.": "Die ersten 300 von {count} werden gezeigt.",
  "On schedule": "Nach Zeitplan",
  "Alarm": "Alarm",
  "Manual": "Manuell",

  "Read the configuration": "Konfiguration lesen",
  "Reading the configuration tree…": "Konfigurationsbaum wird gelesen…",
  "Pick a section on the left.": "Wähle links einen Abschnitt.",
  "Reading…": "Wird gelesen…",

  "Shared log": "Gemeinsames Protokoll",
  "The panel and the server write into one file, {file}, beside the Home Assistant configuration, on one clock counted from the page load. That shows the order of events lasting fractions of a second — why a tile blinked on refresh, for instance.": "Panel und Server schreiben in eine Datei, {file}, neben der Home-Assistant-Konfiguration, auf einer gemeinsamen Uhr ab dem Laden der Seite. So wird die Reihenfolge von Ereignissen sichtbar, die Bruchteile einer Sekunde dauern — etwa warum eine Kachel beim Neuladen blinkte.",
  "Off by default, and nothing is sent anywhere.": "Standardmäßig aus, und es wird nichts irgendwohin gesendet.",
  "Recording — reload the page to capture a start.": "Aufzeichnung läuft — lade die Seite neu, um einen Start festzuhalten.",
  "Stop recording": "Aufzeichnung beenden",
  "Start recording": "Aufzeichnung starten",
  "Show the file": "Datei anzeigen",
  "The file is empty.": "Die Datei ist leer.",
  "Could not read it: {error}": "Konnte nicht gelesen werden: {error}",

  "Developer report": "Bericht für die Entwicklung",
  "Collects the model, the firmware, what the recorder can do, the encoder settings and the state of the player — what is needed to understand how your particular device behaves.": "Sammelt Modell, Firmware, die Fähigkeiten des Rekorders, die Encoder-Einstellungen und den Zustand des Players — das, was nötig ist, um das Verhalten genau deines Geräts zu verstehen.",
  "Passwords, hashes, serial numbers, MAC and IP addresses are stripped automatically. The report is not sent anywhere by itself — you copy it or open an issue.": "Passwörter, Hashes, Seriennummern sowie MAC- und IP-Adressen werden automatisch entfernt. Der Bericht geht von allein nirgendwohin — du kopierst ihn oder öffnest ein Issue.",
  "Build the report": "Bericht erstellen",
  "Building…": "Wird erstellt…",
  "Copy": "Kopieren",
  "Download .md": ".md herunterladen",
  "Open an issue on GitHub": "Issue auf GitHub öffnen",
  "Refresh": "Aktualisieren",
  "Could not build the report: {error}": "Bericht konnte nicht erstellt werden: {error}",

  "Read the log": "Protokoll lesen",
  "Reading the log…": "Protokoll wird gelesen…",
  "The log is empty.": "Das Protokoll ist leer.",
  "Time": "Zeit",
  "User": "Benutzer",
  "Details": "Details",
  "{count} channels": ({ count }) => (count === 1 ? "{count} Kanal" : "{count} Kanäle"),
  "Overview": "Übersicht",
  "Channels": "Kanäle",
  "Archive": "Archiv",
  "Configuration": "Konfiguration",
  "Settings": "Einstellungen",
  "Log": "Protokoll",
  "Report": "Bericht",
  "Loading…": "Wird geladen…",
  "No data": "Keine Daten",
  "No recorder is configured.": "Es ist kein Rekorder eingerichtet.",

  "Stream": "Stream",
  "Disk": "Speicher",
  "Uptime": "Laufzeit",
  "recording: {count}": "Aufnahme: {count}",
  "to {day}": "bis {day}",

  "{shown} of {total} channels on the wall": "{shown} von {total} Kanälen an der Wand",
  "Fullscreen (Esc to leave)": "Vollbild (Esc zum Verlassen)",
  "Wall channels": "Kanäle der Wand",
  "On the wall, camera online": "An der Wand, Kamera online",
  "On the wall, camera offline": "An der Wand, Kamera offline",
  "Not on the wall": "Nicht an der Wand",
  "Drag the row to reorder": "Zeile ziehen, um die Reihenfolge zu ändern",
  "Stream of this camera on the wall": "Stream dieser Kamera an der Wand",
  "connecting…": "verbinde…",
  "offline": "offline",
  "could not decode": "konnte nicht dekodiert werden",
  "no address for the stream": "keine Adresse für den Stream",
  "attempt {attempt} in {seconds}s": "Versuch {attempt} in {seconds} s",
  "could not be recovered": "konnte nicht wiederhergestellt werden",
  "the camera sends no video": "die Kamera sendet kein Video",
  "the recorder cut the stream": "der Rekorder hat den Stream beendet",
  "connection to the recorder failed": "Verbindung zum Rekorder gestört",

  "recording": "Aufnahme",
  "motion": "Bewegung",
  "no signal": "kein Signal",
  "No frame": "Kein Bild",
  "Offline": "Offline",
  "Name": "Name",
  "State": "Zustand",
  "Resolution": "Auflösung",
  "Bitrate": "Bitrate",
  "Recording": "Aufnahme",
  "Motion": "Bewegung",
  "Connected": "Verbunden",
  "yes": "ja",
  "{kbps} kbit/s": "{kbps} kbit/s",

  "Sub": "Sub",
  "Main": "Haupt",
  "Native (WebCodecs)": "Nativ (WebCodecs)",
  "Snapshots": "Schnappschüsse",
  "{reason}. Switched to the sub stream.": "{reason}. Auf den Substream gewechselt.",
  "{reason}. Switched to snapshots.": "{reason}. Auf Schnappschüsse gewechselt.",

  "{days}d {hours}h": "{days} T {hours} Std",
  "{hours}h {minutes}m": "{hours} Std {minutes} Min",
  "{minutes}m": "{minutes} Min",
  "{value} Mbit/s": "{value} Mbit/s",
  "B": "B",
  "KB": "KB",
  "MB": "MB",
  "GB": "GB",
  "TB": "TB",
};

//: English needs no dictionary — the source text is the answer — with one
//: exception: it counts too, and "1 channels" is wrong in every language.
const EN = {
  "{count} channels": ({ count }) => (count === 1 ? "{count} channel" : "{count} channels"),
};

export const DICTIONARIES = { en: EN, uk: UK, es: ES, fr: FR, de: DE };

let active = {};

/**
 * Choose the language, from what Home Assistant says the user reads.
 *
 * "de-CH" and "de" are the same dictionary here; regional differences are not
 * worth five more files for an interface this size. An unknown language leaves
 * the source text alone, which is English.
 */
export function useLanguage(language) {
  const code = String(language || "en").toLowerCase();
  active = DICTIONARIES[code] || DICTIONARIES[code.split("-")[0]] || {};
  return active;
}

/**
 * Translate, and fill in the values.
 *
 * @param {string} text the English source, which is also the key
 * @param {object} [values] substituted wherever the translation puts {name}
 */
export function t(text, values) {
  const entry = active[text] || text;
  // A dictionary entry may be a function, for the languages where a count
  // changes the words around it. Ukrainian has three forms where English has
  // two, and "1 каналів" is exactly the kind of thing a viewer notices.
  const line = typeof entry === "function" ? entry(values || {}) : entry;
  if (!values) return line;
  return line.replace(FILL, (whole, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : whole
  );
}
