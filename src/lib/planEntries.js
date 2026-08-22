export function buildPlanEntries(plan, startDate = new Date(), allowedRecipeIds = undefined) {
  const allowed = allowedRecipeIds ? new Set(allowedRecipeIds) : null;
  if (!Array.isArray(plan) || plan.length === 0 || plan.length > 42) {
    throw new Error('Plan mora imati 1-42 stavke');
  }

  return plan.map((item) => {
    if (!Number.isInteger(item?.dayOffset) || item.dayOffset < 0 || item.dayOffset > 13) {
      throw new Error('AI plan sadrži nevažeći dayOffset');
    }
    if (!['breakfast', 'lunch', 'dinner'].includes(item.mealType)) {
      throw new Error('AI plan sadrži nevažeći mealType');
    }
    if (typeof item.recipeId !== 'string' || (allowed && !allowed.has(item.recipeId))) {
      throw new Error('AI plan sadrži nedostupan recipeId');
    }

    const date = new Date(startDate);
    date.setDate(startDate.getDate() + item.dayOffset);
    return {
      date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      mealType: item.mealType,
      recipeId: item.recipeId,
    };
  });
}
