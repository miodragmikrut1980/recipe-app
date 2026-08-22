import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import { saveRecipe, findPossibleDuplicate } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { normalizeAiRecipe } from '../lib/validation.js';
import { sendRouteError } from '../lib/httpError.js';

const router = Router();
const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, callback) {
    callback(allowedImageTypes.has(file.mimetype) ? null : Object.assign(new Error('Dozvoljene su JPEG, PNG, WebP i GIF slike'), { status: 415 }), allowedImageTypes.has(file.mimetype));
  },
});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VISION_PROMPT = `Pogledaj fotografiju recepta (moze biti stranica iz kuvara, rukom pisana kartica, ili skrinsot) i vrati ISKLJUCIVO validan JSON, bez dodatnog teksta:
{
  "title": "naziv jela",
  "servings": broj ili null,
  "ingredients": [{"name": "naziv sastojka", "amount": "kolicina ili prazan string"}],
  "steps": ["korak 1", "korak 2"],
  "prepTimeMinutes": broj ili null,
  "tags": ["kategorija1"],
  "nutritionPerServing": {"calories": broj ili null, "proteinGrams": broj ili null, "carbsGrams": broj ili null, "fatGrams": broj ili null}
}
Ako je tekst na fotografiji nejasan ili nekompletan, popuni sto vise mozes procitati i ostavi null gde nije citljivo. Ne izmisljaj sastojke koji se ne vide na slici.`;

router.post('/parse-recipe-photo', requireAuth, upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nedostaje fotografija ("photo" polje u form-data)' });
  }

  try {
    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString('base64');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: req.file.mimetype, data: base64Image },
            },
            { type: 'text', text: VISION_PROMPT },
          ],
        },
      ],
    });

    const textBlock = message.content.find((b) => b.type === 'text');
    const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
    const parsed = normalizeAiRecipe(JSON.parse(cleaned));

    const recipe = {
      id: randomUUID(),
      title: parsed.title,
      sourceUrl: 'scanned-photo',
      sourcePlatform: 'other',
      servings: parsed.servings ?? null,
      ingredients: parsed.ingredients,
      steps: parsed.steps,
      prepTimeMinutes: parsed.prepTimeMinutes ?? null,
      tags: parsed.tags,
      nutritionPerServing: parsed.nutritionPerServing,
      createdAt: new Date().toISOString(),
    };

    const savedRecipe = await saveRecipe(recipe, req.user.id);
    const duplicateOf = await findPossibleDuplicate(savedRecipe.title, req.user.id, savedRecipe.id).catch(() => null);
    res.json({ recipe: savedRecipe, duplicateOf });
  } catch (err) {
    console.error('Greska pri skeniranju recepta:', err);
    sendRouteError(res, err, 'Obrada fotografije nije uspela');
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

export default router;
