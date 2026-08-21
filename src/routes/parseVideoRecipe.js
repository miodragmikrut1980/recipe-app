import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import { transcribeVideo, extractFrames } from '../services/transcription.js';
import { parseRecipeFromText } from '../services/aiParser.js';
import { saveRecipe, findPossibleDuplicate } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Limit podignut na 100MB — audio se izvlaci pre slanja Whisper-u pa veliki
// video vise nije problem za transkripciju
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 100 * 1024 * 1024 } });

const FRAMES_PROMPT = `Ovo su kadrovi iz videa recepta (recept je verovatno prikazan kao tekst na ekranu). Procitaj sav vidljiv tekst i sastavi recept. Vrati ISKLJUCIVO validan JSON:
{"title": "...", "servings": broj|null, "ingredients": [{"name": "...", "amount": "..."}], "steps": ["..."], "prepTimeMinutes": broj|null, "tags": ["..."], "nutritionPerServing": {"calories": broj|null, "proteinGrams": broj|null, "carbsGrams": broj|null, "fatGrams": broj|null}}
Koristi domace mere (šolja, kašika, g, ml). Ne izmisljaj ono sto se ne vidi.`;

async function parseFromFrames(videoPath, sourceUrl) {
  const frames = await extractFrames(videoPath, 4);
  try {
    const imageBlocks = frames.map((framePath) => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: fs.readFileSync(framePath).toString('base64'),
      },
    }));

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: FRAMES_PROMPT }] }],
    });

    const textBlock = message.content.find((b) => b.type === 'text');
    const parsed = JSON.parse(textBlock.text.replace(/```json|```/g, '').trim());

    return {
      id: randomUUID(),
      title: parsed.title || 'Nepoznat recept',
      sourceUrl,
      sourcePlatform: 'other',
      servings: parsed.servings ?? null,
      ingredients: parsed.ingredients || [],
      steps: parsed.steps || [],
      prepTimeMinutes: parsed.prepTimeMinutes ?? null,
      tags: parsed.tags || [],
      nutritionPerServing: parsed.nutritionPerServing || null,
      createdAt: new Date().toISOString(),
    };
  } finally {
    for (const f of frames) fs.unlink(f, () => {});
  }
}

/**
 * Video stize direktno sa korisnikovog telefona (sacuvan preko Instagram-ove
 * zvanicne "Save to camera roll" opcije, pa podeljen iz galerije).
 *
 * Tok: 1) izvuci audio, transkribuj govor
 *      2) ako govora nema/premalo — fallback na citanje kadrova (text-overlay recepti)
 *      3) opcioni "caption" iz body-ja se kombinuje sa transkriptom za bolji rezultat
 */
router.post('/parse-recipe-video', requireAuth, upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nedostaje video fajl ("video" polje u form-data)' });
  }

  const caption = req.body?.caption?.trim() || null;

  try {
    let recipe;
    let transcript = null;

    try {
      transcript = await transcribeVideo(req.file.path);
    } catch (err) {
      console.warn('Transkripcija nije uspela, idem na kadrove:', err.message);
    }

    const hasSpeech = transcript && transcript.trim().length >= 30;

    if (hasSpeech) {
      recipe = await parseRecipeFromText(transcript, 'shared-video', caption);
    } else if (caption) {
      // Nema govora ali imamo caption — parsiraj caption
      recipe = await parseRecipeFromText(caption, 'shared-video');
    } else {
      // Nema ni govora ni captiona — probaj da procitas tekst sa kadrova
      recipe = await parseFromFrames(req.file.path, 'shared-video');
    }

    const savedRecipe = await saveRecipe(recipe, req.user.id);
    const duplicateOf = await findPossibleDuplicate(savedRecipe.title, req.user.id, savedRecipe.id).catch(() => null);
    res.json({ recipe: savedRecipe, transcript: hasSpeech ? transcript : null, duplicateOf });
  } catch (err) {
    console.error('Greska pri obradi video recepta:', err);
    res.status(500).json({ error: err.message || 'Nepoznata greska pri obradi videa' });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

export default router;
