import { Router } from 'express';
import { parseRecipeFromText } from '../services/aiParser.js';
import { fetchPostThumbnail } from '../services/instagramEmbed.js';
import { fetchLinkPreview, looksLikeRecipe } from '../services/linkPreview.js';
import { fetchYouTubeDescription, isYouTubeUrl } from '../services/youtubeApi.js';
import { saveRecipe, findPossibleDuplicate } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { httpUrl, stringValue } from '../lib/validation.js';

const router = Router();

/**
 * Jedan endpoint, dva rezima:
 *
 * 1. AUTO (samo { url }): backend sam procita caption sa javne stranice
 *    posta (link unfurling, kao WhatsApp preview). Ako caption lici na
 *    recept — parsira i cuva BEZ ijednog dodatnog koraka korisnika.
 *    Ako ne — vraca 422 { code: 'AUTO_EXTRACT_FAILED' } i app prelazi
 *    na rucni unos.
 *
 * 2. RUCNI ({ url, text }): korisnik je nalepio caption sam — parsira se
 *    prosledjeni tekst (fallback, radi kao i do sada).
 */
router.post('/parse-recipe', requireAuth, async (req, res) => {
  let { url, text } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Nedostaje "url" u telu zahteva' });
  }

  try {
    url = httpUrl(url);
    text = text == null ? undefined : stringValue(text, 'text', { required: false, max: 50000 });
    let recipeText = text?.trim() || null;

    if (!recipeText) {
      // YouTube ima zvanican API sa punim opisom — koristi ga kad je moguce,
      // jer je og:description na YouTube-u skracen (~150 karaktera)
      const preview = isYouTubeUrl(url)
        ? (await fetchYouTubeDescription(url)) || (await fetchLinkPreview(url))
        : await fetchLinkPreview(url);

      if (preview && looksLikeRecipe(preview.caption)) {
        recipeText = preview.title
          ? `${preview.title}\n\n${preview.caption}`
          : preview.caption;
      } else {
        return res.status(422).json({
          code: 'AUTO_EXTRACT_FAILED',
          error:
            'Opis posta ne sadrži recept (ili post nije javan). Nalepi tekst ručno ili podeli sačuvan video.',
        });
      }
    }

    const [recipe, thumbnail] = await Promise.all([
      parseRecipeFromText(recipeText, url),
      fetchPostThumbnail(url),
    ]);

    if (thumbnail?.thumbnailUrl) {
      recipe.thumbnailUrl = thumbnail.thumbnailUrl;
    }

    const savedRecipe = await saveRecipe(recipe, req.user.id);
    const duplicateOf = await findPossibleDuplicate(savedRecipe.title, req.user.id, savedRecipe.id).catch(() => null);
    res.json({ recipe: savedRecipe, duplicateOf });
  } catch (err) {
    console.error('Greska pri parsiranju recepta:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Obrada recepta nije uspela' });
  }
});

export default router;
