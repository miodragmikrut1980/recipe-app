/**
 * Zvanicni YouTube Data API v3 — jedina od cetiri platforme koja nudi
 * pravi, ToS-dozvoljen nacin da se dobije PUN opis videa (og:description
 * na YouTube stranicama je skracen na ~150 karaktera, sto je premalo za
 * recepte koji su cesto duzi opisi).
 *
 * Besplatan API kljuc: console.cloud.google.com -> novi projekat ->
 * Enable API -> "YouTube Data API v3" -> Credentials -> Create API Key.
 * Besplatan kvota: 10,000 "units" dnevno; jedan videos.list poziv kosta
 * 1 unit, dakle ~10,000 recepata dnevno pre nego sto bi ovo bilo problem.
 */
const API_KEY = process.env.YOUTUBE_API_KEY;

function extractVideoId(url) {
  // Podrzava: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/shorts/ID
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * Vraca { caption, title } sa punim opisom videa, ili null ako nije
 * YouTube link, nema kljuca, ili poziv ne uspe (privatan/obrisan video).
 */
export async function fetchYouTubeDescription(url) {
  if (!API_KEY) {
    console.warn('YOUTUBE_API_KEY nije podesen — YouTube linkovi idu na og: fallback');
    return null;
  }

  const videoId = extractVideoId(url);
  if (!videoId) return null;

  try {
    const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${API_KEY}`;
    const response = await fetch(apiUrl);
    if (!response.ok) {
      console.warn(`YouTube API greska: ${response.status}`);
      return null;
    }
    const data = await response.json();
    const snippet = data.items?.[0]?.snippet;
    if (!snippet) return null;

    return { caption: snippet.description || '', title: snippet.title || null };
  } catch (err) {
    console.warn(`YouTube API poziv nije uspeo: ${err.message}`);
    return null;
  }
}

export function isYouTubeUrl(url) {
  return /youtube\.com|youtu\.be/.test(url);
}
