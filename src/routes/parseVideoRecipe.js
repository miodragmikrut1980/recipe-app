import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import { transcribeVideo, extractFrames } from '../services/transcription.js';
import { parseRecipeFromText } from '../services/aiParser.js';
import { saveRecipe, findPossibleDuplicate } from '../services/db.js';
import { recordHouseholdActivity } from '../services/householdAccess.js';
import { requireAuth } from '../middleware/auth.js';
import { normalizeAiRecipe, stringValue } from '../lib/validation.js';
import { sendRouteError } from '../lib/httpError.js';
import { verifyUploadedFile } from '../lib/fileSignature.js';
import { logger } from '../lib/logger.js';

const router = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Limit podignut na 100MB — audio se izvlaci pre slanja Whisper-u pa veliki
// video vise nije problem za transkripciju
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, callback) {
    const allowed = file.mimetype.startsWith('video/');
    callback(allowed ? null : Object.assign(new Error('Fajl mora biti video'), { status: 415 }), allowed);
  },
});

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
    const parsed = normalizeAiRecipe(JSON.parse(textBlock.text.replace(/```json|```/g, '').trim()));

    return {
      id: randomUUID(),
      title: parsed.title,
      sourceUrl,
      sourcePlatform: 'other',
      servings: parsed.servings ?? null,
      ingredients: parsed.ingredients,
      steps: parsed.steps,
      prepTimeMinutes: parsed.prepTimeMinutes ?? null,
      tags: parsed.tags,
      nutritionPerServing: parsed.nutritionPerServing,
      createdAt: new Date().toISOString(),
    };
  } finally {
    for (const f of frames) fs.unlink(f, () => {});
    if (frames[0]) fs.rm(path.dirname(frames[0]), { recursive: true, force: true }, () => {});
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

  let caption;
  try { caption = req.body?.caption == null ? null : stringValue(req.body.caption, 'caption', { required: false, max: 50000 }) || null; }
  catch (err) { fs.unlink(req.file.path, () => {}); return res.status(err.status || 400).json({ error: err.message }); }

  try {
    verifyUploadedFile(req.file.path, 'video');
    let recipe;
    let transcript = null;

    try {
      transcript = await transcribeVideo(req.file.path);
    } catch (err) {
      logger.warn('video_transcription_fallback', { requestId: req.requestId, errorName: err?.name || 'Error' });
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
    await recordHouseholdActivity(req.user.id, { action: 'recipe_added', entityType: 'recipe', entityId: savedRecipe.id, summary: `Dodat recept iz videa: ${savedRecipe.title}` });
    const duplicateOf = await findPossibleDuplicate(savedRecipe.title, req.user.id, savedRecipe.id).catch(() => null);
    res.json({ recipe: savedRecipe, transcript: hasSpeech ? transcript : null, duplicateOf });
  } catch (err) {
    logger.error('recipe_video_failed', err, { requestId: req.requestId });
    sendRouteError(res, err, 'Obrada videa nije uspela', req.requestId);
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

export default router;
