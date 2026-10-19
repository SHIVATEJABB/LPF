# LinkedIn Lead Finder

Paste leads copied from LinkedIn Sales Navigator. The tool cleans the text, searches Google for each
person's LinkedIn profile (`site:linkedin.com/in/ "Name" "Company"`), checks that each result is the right
person, and gives you a sheet you can download as Excel or CSV.
It can also find **new** people with your own job title, location and keyword searches.

The tool runs on your own computer. It never logs in to LinkedIn and never opens LinkedIn pages; it only
reads Google results through a search API (SerpApi or Serper).

---

## 1. One-time setup

1. **Install Python 3** (free): <https://www.python.org/downloads/>.
   On Windows, tick **"Add python.exe to PATH"** on the first install screen.
2. **Get a search API key** (needed for automatic searching):
   - **SerpApi**: <https://serpapi.com> → *Your Account* → *API Key*, or
   - **Serper**: <https://serper.dev> → *API Key*.

   No key yet? Choose **Mock test mode** in Settings to try everything with made-up results, free.

## 2. Start the tool

1. Extract the whole ZIP to a folder (for example `Documents\LinkedIn Lead Finder`).
   Running it from inside the ZIP does not work.
2. **Windows:** double-click **`START_HERE.py`**. (`START_WINDOWS.bat` does the same, but Windows Smart App
   Control blocks `.bat` files that came from the internet – see Troubleshooting.)
   If Windows asks how to open the file, choose **Python**.
   **Mac / Linux:** open Terminal in the folder and run `sh start_mac_linux.sh`.
3. A black window opens and your browser opens <http://127.0.0.1:8765>.
   **Keep the black window open** while you use the tool. Close it when you are done.
4. Click **⚙ Settings**, choose SerpApi or Serper, paste your key, click **Save key**, then **Test connection**.

## 3. Find profiles for your Sales Navigator leads

1. In Sales Navigator, open a lead list or a search results page. Press **Ctrl+A**, then **Ctrl+C**.
2. Paste into box 1 and click **Clean & add leads**.
   Junk text such as "Saved Badge", "2nd", "1 List", "(+1)", "Add note", "No activity" and dates is removed,
   and each person's name, job title, company and location are kept together.
3. Go to the next Sales Navigator page and repeat. Each paste is **added** to the sheet, and people already there are skipped.
4. In box 2, choose how many to search, then click **▶ Start search**.
5. Check the **Review** rows, then click **⬇ Download Excel** or **⬇ Download CSV**.

You can also paste a table copied from Excel or Google Sheets (with a header row such as *Name, Title, Company, Location*),
or use **Import CSV file**.

### Search settings (all custom numbers)

| Setting | What it does |
|---|---|
| **Max leads to search** | Any number: 300, 3000… **0 = all rows**. |
| **Start at row #** | Work in batches, e.g. start at 301 to do rows 301–600. |
| **Google results to check per query** | 10 = one Google page (1 credit). 20 = two pages (2 credits). |
| **Queries per lead** | Backup searches when the first one finds nothing good (see templates below). |
| **Only search rows not searched yet** | On = rows already done are skipped, so you can stop and continue later. |

Under **Settings** you can also change the Google country (`in`, `us`…), parallel searches, the pause between searches,
the score needed for *Matched* / *Review*, and the **query templates**. The defaults are tried in order:

```
site:linkedin.com/in/ "{name}" "{company}"
site:linkedin.com/in/ "{name}" "{city}"
site:linkedin.com/in/ "{name}"
```

Available fields: `{name} {first} {last} {company} {title} {city} {location}`. A template is skipped for a lead
that is missing one of its fields (for example, no company).

### What the statuses mean

| Status | Meaning |
|---|---|
| **Matched** | Name matches and company (or title) is confirmed by the Google result. |
| **Review** | Probably the person, but not confirmed. Click **▾** to see what Google returned, then **✓** or **Use this**. |
| **Not found** | No suitable LinkedIn profile in the results. Click **Google** to search yourself, then paste the URL in the row. |
| **Confirmed** | You chose or typed the URL yourself. |
| **Found** | Added by Custom lead search. |
| **Error** | The search failed; the reason is shown under the status. |

Two leads that end up with the same URL are flagged in the Notes column.

## 4. Custom lead search (find new people)

Open the **Custom lead search** tab and enter job titles, locations and (optionally) keywords and words to exclude.
Every title is searched with every location, e.g. `site:linkedin.com/in/ "Head of Operations" "Chennai"`.
Set **How many leads do you want?** (e.g. 300 or 3000); the search stops when it gets there.
Google returns at most about 10 pages per query, so for big numbers add more titles, locations or keywords.
Click **Preview queries** to see the queries and the maximum number of credits before you run them.
Advanced users can type their own Google queries.

## 5. Costs

- One Google page (10 results) = **1 search credit**. A typical lead uses 1–2 credits.
- The tool shows an estimate before you start and asks before any run that could use more than 50 credits.
- Results are cached on your computer for 30 days (changeable), so searching the same thing again is free.
- If the key is wrong or the credits run out, the run **stops at once** so nothing else is wasted.

## 6. Your data

Everything stays in the `data` folder next to the tool: `config.json` (your API key), `session.json` (your sheet,
saved automatically) and `cache.sqlite3` (cached results). Closing the browser does not lose your sheet. To start fresh,
click **Clear sheet**, or delete the `data` folder.

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| "Python 3 is not installed" | Install Python (step 1) with "Add python.exe to PATH" ticked, then start again. |
| "Smart App Control blocked…" / "dangerous file extension" | Windows blocks downloaded `.bat` files. Double-click **`START_HERE.py`** instead. Or: delete the folder, right-click the ZIP → **Properties** → tick **Unblock** → **OK**, extract again. |
| Red "Server not connected" | The black window was closed. Double-click `START_HERE.py` again and reload the page. |
| Page says you opened the file directly | Don't open `index.html` yourself. Start `START_HERE.py` and use <http://127.0.0.1:8765>. |
| "Invalid API key" / "run out of searches" | Check the key in Settings → **Test connection**, or your plan at serpapi.com / serper.dev. |
| "SSL certificate check failed" | Mac: run *Install Certificates.command* in your Python folder. Work PCs: ask IT about HTTPS inspection. |
| Many **Not found** | Normal for people who are not public on Google. Try a 3rd query per lead, or search them yourself with the **Google** link. |
| Download does nothing | Look in your Downloads folder and the browser's download bar. Or use **Copy table for Google Sheets** and paste. |
| Port already in use | Another copy is running. The tool picks the next free port automatically; use the address shown in the black window. |

## 8. Good to know

- Google does not show every LinkedIn profile, and its snippets can be out of date. That is why results are scored and
  uncertain ones are marked **Review** instead of being guessed.
- Mock test mode makes up fake people and fake `linkedin.com/in/mock-…` links. Don't use those rows for outreach.
- Use the tool in line with LinkedIn's and your search provider's terms of use.

---

### For developers

No dependencies: the server is Python standard library only, and the page is plain HTML/JS.

```bash
node --test tests/core.test.js                    # parser, matcher, query builder, CSV/XLSX writer
python3 -m unittest discover -s tests -v          # server against a fake SerpApi/Serper
node tests/e2e.js                                 # real Chromium: paste → search → download (needs Playwright)
```

`tests/fixtures/saved_leads_sample.txt` is a real Sales Navigator "saved leads" paste (25 people).
Environment variables: `SERPAPI_KEY`, `SERPER_API_KEY` (instead of saving a key), `LLF_PORT`, `LLF_DATA_DIR`.
