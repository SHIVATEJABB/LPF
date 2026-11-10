# LinkedIn Lead Finder

Paste leads copied from LinkedIn Sales Navigator. The tool cleans the text, searches Google for each
person's LinkedIn profile (`site:linkedin.com/in/ "Name" "Company"`), checks that each result is the right
person, and gives you a sheet you can download as Excel or CSV.
It can also find **new** people with Sales Navigator-style filters (designation, seniority, company, region…),
and find **companies** by industry, location and size, then the right people at those companies.

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

### What else you get for each lead

- **From the person's LinkedIn result (free):** *Title on LinkedIn*, *Company on LinkedIn* and the location.
  For sure matches, empty Job Title / Company / Location cells are filled in. A different LinkedIn company is shown
  under the company name, which often means the person changed jobs.
- **Company details (tick in section 2):** *Company Website* and *Company LinkedIn URL*, plus industry, size and
  headquarters when Google shows them. This costs about 1 search per **company** for each, not per person, and each
  company is only looked up once. Use **Find company details only** to fill them in for rows you already have.
- Websites are taken from Google's info panel, or a result whose domain or home page matches the company name.
  Social, directory and news sites are never used. Check websites for very short or common company names.

### Emails & phone numbers (optional, uses a provider's credits)

The tool can ask an email/phone data provider for each **matched** lead (Review rows only if you tick it):

| Provider | Finds | How it works |
|---|---|---|
| **Hunter** (hunter.io) | Emails (phone only when public) | One request per lead, using name + company website |
| **Apollo** (apollo.io) | Emails | One request per lead, using name, company, website and LinkedIn URL |
| **FullEnrich** (fullenrich.com) | Emails **and phone numbers** | Batches of up to 100 leads; results arrive after a few minutes |
| **Mock test mode** | Made-up contacts | Free, for trying the tool |

1. **⚙ Settings → Email & phone finder:** choose the provider, paste its API key, **Save key**, **Test connection**.
2. In section 2 tick **Email** and/or **Phone number**. They are off by default, so nothing is spent unless you tick them.
3. Run **▶ Start search** (looks up contacts after the profiles), or **Find emails & phones only** for leads you already searched.

- Emails already in your list are never replaced. Each lead is only looked up once per provider.
- A wrong key or empty credit balance stops the run straight away.
- FullEnrich keeps working if you close the page: click **Find emails & phones only** later to collect the results
  without paying again.
- New columns: **Email**, **Email Status**, **Phone**, **Email/Phone Source**.
- Check the rules for cold email where your leads are (e.g. CAN-SPAM in the US, GDPR in the EU/UK).

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

## 4. Lead search (find new people with filters)

Open the **Lead search (filters)** tab. Fill in only what you need:

| Filter | Example | How it is used |
|---|---|---|
| **Designations / job titles** | `Head of Sales` | Searched as written, and checked in the person's headline. |
| **Seniority** | ☑ Director, ☑ VP | Adds those titles (Director; Vice President, VP…). |
| **Department / function** | `Sales` | Must appear in the headline. |
| **Companies** | `Zoho` | Searched, and checked against the person's company. |
| **Regions / cities** | `Chennai` | Searched, and checked against the profile location. |
| **Country** | India | Google country; used as the region when no cities are given. |
| **Industry / keywords** | `SaaS` | Extra search words. |
| **Exclude words** | `intern, student` | Results containing these words are skipped. |

Every value is combined with every other into separate Google searches, e.g.
`site:linkedin.com/in/ "Head of Sales" "Zoho" "Chennai"`. Google shows at most ~100 results per search, so the tool
moves on to the next search when one runs out. More designations, companies or regions give more leads.

Each profile found is checked against your filters. The **Filter Match** column shows e.g.
`Title ✓ · Company ✓ · Location ?` (`?` = Google doesn't show it). Profiles that fail a filter are added as **Review**.

- **Current company only:** ignores people who only *used to* work at the company.
- **Strict:** keeps only people who match every filter (cleaner, fewer leads).
- **How many leads do you want?:** counts matching leads only; the search stops when it gets there.
- Click **Preview searches** to see every search and the maximum credits before you run them.

## 5. Company search (find companies, then their people)

1. Open the **Company search** tab. Enter industries/keywords (e.g. `roofing`), locations (e.g. `Dallas`), and optionally
   tick company sizes. Size is only known when Google shows it; tick *Keep companies whose size Google doesn't show* to keep the rest.
2. Click **Find companies**. You get a company list with industry, size, headquarters, followers and LinkedIn page.
   **Download companies (Excel)** saves it.
3. Tick the companies you want and click **Find people at selected companies →**. They are copied into Lead search, with
   *Current company only* switched on.
4. Add designations or seniority (and regions if you like), click **Preview searches**, then **Find leads**.
   With many companies, 1–2 Google pages per search is usually enough and saves credits.

## 6. Costs

- One Google page (10 results) = **1 search credit**. A typical lead uses 1–2 credits.
- The tool shows an estimate before you start and asks before any run that could use more than 50 credits.
- Results are cached on your computer for 30 days (changeable), so searching the same thing again is free.
- If the key is wrong or the credits run out, the run **stops at once** so nothing else is wasted.

## 7. Your data

Everything stays in the `data` folder next to the tool: `config.json` (your API key), `session.json` (your sheet,
saved automatically) and `cache.sqlite3` (cached results). Closing the browser does not lose your sheet. To start fresh,
click **Clear sheet**, or delete the `data` folder.

## 8. Troubleshooting

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

## 9. Good to know

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
