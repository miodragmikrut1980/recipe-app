/**
 * Koristi Instagram-ov zvanicni oEmbed endpoint da dobije thumbnail sliku
 * i osnovne podatke o postu, iskljucivo radi PRIKAZA posta u nasoj app-i.
 *
 * VAZNO — Instagram-ovi uslovi koriscenja izricito zabranjuju izvlacenje,
 * obradu ili trajno cuvanje metapodataka/sadrzaja iz oEmbed-a za bilo koju
 * svrhu osim prikazivanja posta korisniku (npr. slanje AI-ju radi parsiranja
 * recepta bi bilo kršenje). Zato ova funkcija:
 *   - SME da vrati thumbnail_url za prikaz u app-i
 *   - SME da vrati author_name radi atribucije
 *   - NE SME da se koristi za izvlacenje caption teksta radi AI parsiranja —
 *     za to korisnik rucno unosi tekst (vidi routes/parseRecipe.js)
 *
 * Od 15. juna 2026. ovaj endpoint je besplatan i bez tokena za javne postove.
 */
const OEMBED_ENDPOINT = 'https://graph.facebook.com/v25.0/instagram_oembed';

export async function fetchPostThumbnail(url) {
  const params = new URLSearchParams({
    url,
    fields: 'thumbnail_url,author_name,provider_name,provider_url',
  });

  const response = await fetch(`${OEMBED_ENDPOINT}?${params.toString()}`);

  if (!response.ok) {
    // Ako oEmbed ne uspe (npr. privatan nalog, obrisan post), nastavljamo
    // bez thumbnail-a umesto da rusimo ceo tok cuvanja recepta
    console.warn(`oEmbed poziv nije uspeo za ${url}: ${response.status}`);
    return null;
  }

  const data = await response.json();
  return {
    thumbnailUrl: data.thumbnail_url || null,
    authorName: data.author_name || null,
  };
}
