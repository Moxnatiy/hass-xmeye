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
