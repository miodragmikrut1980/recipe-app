import 'dotenv/config';
import './config.js';
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
import pantryRouter from './routes/pantry.js';
import favoritesRouter from './routes/favorites.js';
import marketOffersRouter from './routes/marketOffers.js';
import { listRecipes, deleteRecipe, updateRecipe } from './services/db.js';
import { requireAuth } from './middleware/auth.js';
import { validateRecipePatch } from './lib/validation.js';
import { errorEnvelope, logger, requestContext } from './lib/logger.js';
import { checkReadiness } from './services/readiness.js';
import { notifyOperations } from './services/monitoring.js';
import { requireAiBudget } from './services/aiBudget.js';
import { recordHouseholdActivity, requireHouseholdAdult } from './services/householdAccess.js';

const app = express();
app.set('trust proxy', 1); // Railway je iza proxy-ja — potrebno da rate limiter i IP detekcija rade ispravno

app.use(requestContext);
app.use(errorEnvelope);
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 500) notifyOperations('http_5xx_response', 'error', {
      requestId: req.requestId,
      route: req.path,
      status: res.statusCode,
      userId: req.user?.id,
    });
  });
  next();
});

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
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
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
const aiRouteCosts = new Map([
  ['/parse-recipe', 2],
  ['/parse-recipe-video', 8],
  ['/parse-recipe-photo', 4],
  ['/customize-recipe', 2],
  ['/suggest-recipes', 1],
]);
for (const [path, cost] of aiRouteCosts) app.use(path, requireAuth, requireHouseholdAdult, aiLimiter, requireAiBudget(cost));

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/ready', async (req, res) => {
  try {
    res.json(await checkReadiness());
  } catch (error) {
    logger.error('readiness_failed', error, { requestId: req.requestId });
    res.status(503).json({ status: 'not_ready', requestId: req.requestId });
  }
});

app.get('/recipes', requireAuth, async (req, res) => {
  try {
    const recipes = await listRecipes(req.user.id);
    res.json({ recipes });
  } catch (err) {
    logger.error('recipes_list_failed', err, { requestId: req.requestId });
    res.status(500).json({ error: 'Učitavanje recepata nije uspelo' });
  }
});

app.put('/recipes/:id', requireAuth, requireHouseholdAdult, async (req, res) => {
  try {
    const updated = await updateRecipe(req.params.id, validateRecipePatch(req.body), req.user.id);
    await recordHouseholdActivity(req.user.id, { action: 'recipe_updated', entityType: 'recipe', entityId: updated.id, summary: `Recept je izmenjen: ${updated.title}` });
    res.json({ recipe: updated });
  } catch (err) {
    logger.error('recipe_update_failed', err, { requestId: req.requestId });
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Izmena recepta nije uspela' });
  }
});

app.delete('/recipes/:id', requireAuth, requireHouseholdAdult, async (req, res) => {
  try {
    await deleteRecipe(req.params.id, req.user.id);
    await recordHouseholdActivity(req.user.id, { action: 'recipe_removed', entityType: 'recipe', entityId: req.params.id, summary: 'Recept je uklonjen' });
    res.json({ success: true });
  } catch (err) {
    logger.error('recipe_delete_failed', err, { requestId: req.requestId });
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
app.use(pantryRouter);
app.use(favoritesRouter);
app.use(marketOffersRouter);

app.use((req, res) => res.status(404).json({ error: 'Ruta nije pronađena' }));
app.use((err, req, res, next) => {
  const status = err?.code === 'LIMIT_FILE_SIZE' ? 413 : (Number.isInteger(err.status) ? err.status : 500);
  if (status >= 500) {
    logger.error('unhandled_request_error', err, { requestId: req.requestId });
  }
  res.status(status).json({
    error: status >= 500 ? 'Interna greška servera' : err.message,
    requestId: req.requestId,
    ...(err.code ? { code: err.code } : {}),
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  logger.info('server_started', { port: Number(port), nodeEnv: process.env.NODE_ENV || 'development' });
});
