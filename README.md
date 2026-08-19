# Recipe Saver — backend

## Pokretanje lokalno

```bash
npm install
cp .env.example .env
# popuni sve kljuceve u .env
npm run dev
```

**Zahteva ffmpeg** za obradu videa: `apt install ffmpeg` (Linux) / `brew install ffmpeg` (Mac). Railway/Render ga imaju automatski preko nixpacks.

## Supabase setup

1. Napravi projekat na supabase.com
2. SQL Editor → pokreni `supabase-schema.sql` (pravi tabele + auth trigger + RLS)
3. Project Settings → API: kopiraj URL i service_role ključ u `.env`
4. Authentication → Providers: uključi Email provider

## Autentifikacija

Sve rute (osim `/health`) zahtevaju `Authorization: Bearer <token>` header sa Supabase Auth JWT-om. Mobilna app se loguje direktno preko Supabase-a (anon ključ) i šalje token uz svaki zahtev. Backend verifikuje token i filtrira sve podatke po `user_id`.

Rate limiting: 100 zahteva/15min po IP-u opšte, 20/15min za AI rute.

## Endpointi

**Recepti:** `GET /recipes`, `DELETE /recipes/:id`
**Parsiranje:** `POST /parse-recipe` (link+caption), `POST /parse-recipe-video` (video fajl + opcioni caption; audio se izvlači ffmpeg-om, ako nema govora čitaju se kadrovi), `POST /parse-recipe-photo` (fotografija kuvara)
**Pametne funkcije:** `POST /suggest-recipes` (šta mogu da skuvam), `POST /customize-recipe` (vegansko/pola porcije...), `POST /meal-plan/generate` (AI nedeljni plan)
**Plan i kupovina:** `GET/PUT/DELETE /meal-plan`, `POST /shopping-list/generate`, `GET/PUT /shopping-list`
**Domaćinstvo:** `GET/POST /household`, `POST /household/join` (invite kod), `POST /household/leave` — članovi dele recepte

## Tok obrade videa

1. Korisnik sačuva Reel preko Instagram-ove "Save to camera roll" opcije i podeli fajl iz galerije (legalan put — ništa se ne preuzima sa Instagrama)
2. ffmpeg izvuče audio (50MB video → ~2MB mp3, rešava Whisper limit od 25MB)
3. Whisper transkribuje govor (auto-detekcija jezika)
4. Ako nema govora: ffmpeg izvuče 4 kadra → Claude vizija čita tekst sa ekrana
5. Caption (ako je poslat) se kombinuje sa transkriptom za najbolji rezultat
6. Claude strukturira recept (domaće mere: šolja, kašika...) + procena nutricije

## Smoke test (pokreni ovo prvo!)

Automatska provera svih endpointa — sama pravi test korisnika, dobija token i prolazi kroz ceo API:

```bash
npm run dev        # u jednom terminalu
npm test           # u drugom terminalu
```

Skripta ispisuje ✅/❌ za svaki endpoint i rezime na kraju. Ako nešto padne, pogledaj logove servera u prvom terminalu za tačnu grešku — nju mi pošalji i rešavamo.

Napomena: test troši male količine Claude API kredita (2-3 poziva).
