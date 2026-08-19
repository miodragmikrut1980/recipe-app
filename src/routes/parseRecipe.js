import { Router } from 'express';
import { parseRecipeFromText } from '../services/aiParser.js';
import { fetchPostThumbnail } from '../services/instagramEmbed.js';
import { saveRecipe } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * NAPOMENA O DIZAJNU: Instagram-ov zvanicni API ne dozvoljava citanje
 * captiona sa tudjih licnih naloga (samo sopstveni ili tudji Business/
 * Creator nalozi), a njihov oEmbed endpoint izricito zabranjuje koriscenje
 * sadrzaja za bilo sta osim prikazivanja posta korisniku — sto iskljucuje
 * slanje caption-a AI-ju radi trajnog cuvanja strukturiranog recepta.
 *
 * Zato klijent (mobilna app) trazi od korisnika da sam nalepi tekst opisa
 * — to je legalno jer korisnik rucno prosledjuje sadrzaj koji je vec
 * procitao, a ne app koja ga programski izvlaci.
 *
 * Thumbnail sliku i dalje mozemo legalno dobiti preko oEmbed-a jer je to
 * dozvoljena upotreba (prikaz posta), pa je koristimo ovde odvojeno.
 */
router.post('/parse-recipe', requireAuth, async (req, res) => {
  const { url, text } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Nedostaje "url" u telu zahteva' });
  }
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Nedostaje "text" (nalepljen caption) u telu zahteva' });
  }

  try {
    const [recipe, thumbnail] = await Promise.all([
      parseRecipeFromText(text, url),
      fetchPostThumbnail(url),
    ]);

    if (thumbnail?.thumbnailUrl) {
      recipe.thumbnailUrl = thumbnail.thumbnailUrl;
    }

    const savedRecipe = await saveRecipe(recipe, req.user.id);
    res.json({ recipe: savedRecipe });
  } catch (err) {
    console.error('Greska pri parsiranju recepta:', err);
    res.status(500).json({ error: err.message || 'Nepoznata greska' });
  }
});

export default router;
