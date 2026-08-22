import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import parseRecipeRouter from './routes/parseRecipe.js';
import parseVideoRecipeRouter from './routes/parseVideoRecipe.js';
import parsePhotoRecipeRouter from './routes/parsePhotoRecipe.js';
import mealPlanRouter from './routes/mealPlan.js';
import shoppingListRouter from './routes/shoppingList.js';
import smartFeaturesRouter from './routes/smartFeatures.js';
import householdRouter from './routes/household.js';
import ratingsRouter from './routes/ratings.js';
import pushTokenRouter from './routes/pushToken.js';
import { listRecipes, deleteRecipe, updateRecipe } from './services/db.js';
import { requireAuth } from './middleware/auth.js';
import { validateRecipePatch } from './lib/validation.js';

const app = express();
app.set('trust proxy', 1); // Railway je iza proxy-ja — potrebno da rate limiter i IP detekcija rade ispravno

// Loguje BAS SVAKI zahtev, ukljucujuci OPTIONS preflight, PRE bilo kakve
// obrade — korisno za debagovanje, iskljuceno u produkciji da ne pravi sum
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    const start = Date.now();
    console.log(`>>> STIGAO ${req.method} ${req.path}`);
    res.on('finish', () => {
      console.log(`${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
  });
}

const configuredOrigins = (process.env.CORS_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean);
const developmentOrigins = ['http://localhost:3000', 'http://localhost:8081', 'http://127.0.0.1:8081'];
const allowedOrigins = new Set(configuredOrigins.length ? configuredOrigins : (process.env.NODE_ENV === 'production' ? [] : developmentOrigins));
const corsOptions = {
    origin(origin, callback) {
      // Native mobile clients usually do not send Origin. Browser origins must be explicitly allowed.
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(Object.assign(new Error('CORS origin nije dozvoljen'), { status: 403 }));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  };
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json({ limit: '256kb' }));

// Opsti rate limit: 100 zahteva po IP na 15 min
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true }));

// Strozi limit za skupe AI rute (Claude + Whisper pozivi kostaju)
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  keyGenerator: (req) => `user:${req.user.id}`,
});
const aiPaths = ['/parse-recipe', '/parse-recipe-video', '/parse-recipe-photo', '/customize-recipe', '/suggest-recipes', '/meal-plan/generate', '/meal-plan/generate-online'];
app.use(aiPaths, requireAuth, aiLimiter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/recipes', requireAuth, async (req, res) => {
  try {
    const recipes = await listRecipes(req.user.id);
    res.json({ recipes });
  } catch (err) {
    console.error('Greska pri ucitavanju recepata:', err);
    res.status(500).json({ error: 'Učitavanje recepata nije uspelo' });
  }
});

app.put('/recipes/:id', requireAuth, async (req, res) => {
  try {
    const updated = await updateRecipe(req.params.id, validateRecipePatch(req.body), req.user.id);
    res.json({ recipe: updated });
  } catch (err) {
    console.error('Greska pri izmeni recepta:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Izmena recepta nije uspela' });
  }
});

app.delete('/recipes/:id', requireAuth, async (req, res) => {
  try {
    await deleteRecipe(req.params.id, req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Greska pri brisanju recepta:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Brisanje recepta nije uspelo' });
  }
});

app.use(parseRecipeRouter);
app.use(parseVideoRecipeRouter);
app.use(parsePhotoRecipeRouter);
app.use(mealPlanRouter);
app.use(shoppingListRouter);
app.use(smartFeaturesRouter);
app.use(householdRouter);
app.use(ratingsRouter);
app.use(pushTokenRouter);

app.use((req, res) => res.status(404).json({ error: 'Ruta nije pronađena' }));
app.use((err, req, res, next) => {
  const status = err?.code === 'LIMIT_FILE_SIZE' ? 413 : (Number.isInteger(err.status) ? err.status : 500);
  if (status >= 500) console.error('Neobrađena greška:', err);
  res.status(status).json({ error: status >= 500 ? 'Interna greška servera' : err.message, ...(err.code ? { code: err.code } : {}) });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Recipe backend slusa na portu ${port}`);
});
