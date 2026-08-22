function keyPart(value) {
  return String(value || '').trim().toLocaleLowerCase('sr-Latn').replace(/\s+/g, ' ');
}

export function aggregateIngredients(recipes) {
  const grouped = new Map();
  for (const recipe of recipes) {
    for (const ingredient of recipe.ingredients || []) {
      const name = String(ingredient?.name || '').trim();
      if (!name) continue;
      const amount = String(ingredient?.amount || '').trim();
      const key = `${keyPart(name)}\u0000${keyPart(amount)}`;
      const current = grouped.get(key);
      if (current) {
        if (!current.recipeTitles.includes(recipe.title)) current.recipeTitles.push(recipe.title);
      } else {
        grouped.set(key, { name, amount, recipeTitles: [recipe.title], checked: false });
      }
    }
  }
  return [...grouped.values()].map((item) => ({ ...item, recipeTitle: item.recipeTitles.join(', ') }));
}
