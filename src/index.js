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
import { listRecipes, deleteRecipe } from './services/db.js';
import { requireAuth } from './middleware/auth.js';

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

// Opsti rate limit: 100 zahteva po IP na 15 min
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true }));

// Strozi limit za skupe AI rute (Claude + Whisper pozivi kostaju)
const aiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true });
app.use(['/parse-recipe', '/parse-recipe-video', '/parse-recipe-photo', '/customize-recipe', '/suggest-recipes', '/meal-plan/generate'], aiLimiter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/recipes', requireAuth, async (req, res) => {
  try {
    const recipes = await listRecipes(req.user.id);
    res.json({ recipes });
  } catch (err) {
    console.error('Greska pri ucitavanju recepata:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/recipes/:id', requireAuth, async (req, res) => {
  try {
    await deleteRecipe(req.params.id, req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Greska pri brisanju recepta:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use(parseRecipeRouter);
app.use(parseVideoRecipeRouter);
app.use(parsePhotoRecipeRouter);
app.use(mealPlanRouter);
app.use(shoppingListRouter);
app.use(smartFeaturesRouter);
app.use(householdRouter);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Recipe backend slusa na portu ${port}`);
});
