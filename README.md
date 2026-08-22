# Recipe Saver — backend

## Pokretanje lokalno

```bash
npm install
cp .env.example .env
# popuni sve kljuceve u .env
npm run dev
```

Produkcija zahteva Node.js 22+ i eksplicitno podešen `CORS_ORIGINS` (više origin-a se odvaja zarezom).

**Zahteva ffmpeg** za obradu videa: `apt install ffmpeg` (Linux) / `brew install ffmpeg` (Mac). Railway/Render ga imaju automatski preko nixpacks.

## Supabase setup

1. Napravi projekat na supabase.com
2. SQL Editor → pokreni `supabase-schema.sql` (pravi tabele + auth trigger + RLS)
3. Project Settings → API: kopiraj URL i service_role ključ u `.env`
4. Authentication → Providers: uključi Email provider

Za postojeći Supabase projekat ne pokreći celu šemu ponovo. Izvrši migracije ovim redom:

1. `migrations/20260821_security_hardening.sql`
2. `migrations/20260822_production_hardening.sql`
3. `migrations/20260822_staging_operations.sql`

Druga migracija dodaje idempotency i atomske AI planove; treća dodaje dnevnu kontrolu AI budžeta. Bez njih AI rute namerno neće raditi.

## Autentifikacija

Sve rute osim `/health` i `/ready` zahtevaju `Authorization: Bearer <token>`. `/health` proverava proces, a `/ready` i Supabase vezu.

Rate limiting: 100 zahteva/15min po IP-u opšte, 20/15min za AI rute.

## Endpointi

**Recepti:** `GET /recipes`, `PUT /recipes/:id`, `DELETE /recipes/:id`
**Parsiranje:** `POST /parse-recipe` (link+caption), `POST /parse-recipe-video` (video fajl + opcioni caption; audio se izvlači ffmpeg-om, ako nema govora čitaju se kadrovi), `POST /parse-recipe-photo` (fotografija kuvara)
**Pametne funkcije:** `POST /suggest-recipes` (šta mogu da skuvam), `POST /customize-recipe` (vegansko/pola porcije...), `POST /meal-plan/generate` (AI nedeljni plan)
**Plan i kupovina:** `GET/PUT/DELETE /meal-plan`, `POST /shopping-list/generate`, `GET/PUT /shopping-list`
**Domaćinstvo:** `GET/POST /household`, `POST /household/join` (invite kod), `POST /household/leave` — članovi dele recepte
**Ocene/push:** `GET /ratings`, `PUT /recipes/:id/rating`, `POST /push-token`

## Bezbednosne granice

- Backend koristi Supabase `service_role`, zato svaka putanja koja prima recipe ID proverava vlasništvo ili članstvo u domaćinstvu.
- Import URL-a dozvoljava samo javne HTTP(S) adrese. Localhost, privatni/link-local opsezi, interni domeni, DNS rebinding, opasni redirect-i i HTML veći od 2 MB se blokiraju.
- Browser CORS je allowlista iz `CORS_ORIGINS`; native klijenti bez `Origin` header-a su dozvoljeni.
- JSON body je ograničen na 256 KB, fotografija na 10 MB, video na 100 MB. MIME tip se proverava pre obrade.
- AI odgovori se validiraju pre upisa, a nutritivne vrednosti su samo procena.
- Invite kod domaćinstva je 128-bitni nasumični token. Kreiranje i pridruživanje su atomske SQL funkcije dostupne samo `service_role` ulozi.
- Upload se proverava po stvarnom potpisu fajla (magic bytes), ne samo po ekstenziji/MIME header-u.
- Logovi su strukturisani JSON zapisi sa `X-Request-Id`; tokeni, API ključevi i e-mail adrese se rediguju.
- AI plan rute prihvataju `Idempotency-Key`, pa ponovljen zahtev ne pravi duple recepte ili obroke.
- AI rute troše ponderisane dnevne kredite. Limite određuju `AI_DAILY_USER_CREDITS` i `AI_DAILY_GLOBAL_CREDITS`.
- Opcioni `ERROR_WEBHOOK_URL` dobija samo redigovane operativne alarme bez tokena i sadržaja recepta.

## Tok obrade videa

1. Korisnik sačuva Reel preko Instagram-ove "Save to camera roll" opcije i podeli fajl iz galerije (legalan put — ništa se ne preuzima sa Instagrama)
2. ffmpeg izvuče audio (50MB video → ~2MB mp3, rešava Whisper limit od 25MB)
3. Whisper transkribuje govor (auto-detekcija jezika)
4. Ako nema govora: ffmpeg izvuče 4 kadra → Claude vizija čita tekst sa ekrana
5. Caption (ako je poslat) se kombinuje sa transkriptom za najbolji rezultat
6. Claude strukturira recept (domaće mere: šolja, kašika...) + procena nutricije

## Testovi

Brzi lokalni testovi ne zahtevaju API ključeve i ne troše AI kredit:

```bash
npm test
npm run check
```

Pokrivaju SSRF, validaciju, magic bytes, redakciju, monitoring payload, request ID, AI plan, AI budžet i SQL dozvole.

Pravi test Supabase izolacije ne troši AI kredit:

```bash
TEST_API_URL=http://localhost:3000 npm run test:integration
```

Zahteva `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` i `SUPABASE_ANON_KEY` test projekta. GitHub Actions automatski pokreće ovaj scenario kada su unesene odgovarajuće test tajne.

## Integracioni smoke test

Automatska provera svih endpointa — sama pravi test korisnika, dobija token i prolazi kroz ceo API:

```bash
npm run dev        # u jednom terminalu
npm run test:smoke # u drugom terminalu
```

Skripta ispisuje ✅/❌ za svaki endpoint i rezime na kraju. Ako nešto padne, pogledaj logove servera u prvom terminalu za tačnu grešku — nju mi pošalji i rešavamo.

Napomena: smoke test koristi pravi Supabase projekat i troši male količine Claude API kredita (2-3 poziva). Koristi zaseban test projekat, ne produkcionu bazu.
