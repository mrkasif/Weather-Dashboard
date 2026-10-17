# Atmos — Weather Dashboard

A full-stack internship project built with **Python Flask**, vanilla **HTML/CSS/JavaScript**, **OpenWeather API**, and **MongoDB Atlas**.

## Features

- Live current weather for a user-entered city.
- Geocoding API resolves city names to coordinates before weather lookup.
- Current conditions: temperature, feels-like, high/low, humidity, wind, pressure, visibility, and cloud cover.
- Five-day forecast presentation built from OpenWeather's 5-day / 3-hour forecast endpoint. Each day uses the available sample nearest local noon.
- MongoDB-backed search history with city, weather summary, and UTC search timestamp.
- Click a history item to search that city again; clear saved history with confirmation.
- Favorite cities persisted in MongoDB (bookmark button, favorites section, add/remove).
- Hourly forecast strip (3-hour steps, location-local time) plus selectable forecast days.
- Temperature-trend chart (daily highs/lows, dependency-free canvas).
- Celsius/Fahrenheit toggle applied consistently across current, hourly, forecast, history, and favorites.
- Dark navy theme with light-theme toggle, condition/day-night hero treatment, and responsive layout (1440/1024/768/412/390px).
- Rule-based weather summary and clothing/activity suggestions derived from live data (no AI service).
- Search suggestions from history, data-freshness indicator, refresh action, and offline banner.
- Responsive dark UI with lime accents.
- Loading, validation, API error, and database status states.
- API keys are server-side environment variables; frontend code never receives the key.
- Health endpoint and automated tests (mocked; no live credentials required).

## Project structure

```text
weather-dashboard-internship/
├── app.py
├── requirements.txt
├── .env.example
├── .gitignore
├── README.md
├── templates/
│   └── index.html
├── static/
│   ├── css/
│   │   └── styles.css
│   └── js/
│       └── app.js
└── tests/
    └── test_app.py
```

## Requirements

- Python 3.10 or newer
- OpenWeather API key
- MongoDB Atlas cluster and database user (or a compatible MongoDB URI)
- Internet access for weather requests and MongoDB Atlas

## 1. Create API credentials

1. Create an account at https://openweathermap.org/ and generate an API key.
2. Create a MongoDB Atlas cluster at https://www.mongodb.com/atlas.
3. In Atlas, create a database user and configure Network Access to allow your development IP. Avoid allowing access from everywhere unless you understand the security implications.
4. Copy the Atlas connection URI. URL-encode special characters in the database username/password if required.

OpenWeather endpoints used:
- Geocoding: `https://api.openweathermap.org/geo/1.0/direct`
- Current weather: `https://api.openweathermap.org/data/2.5/weather`
- 5-day / 3-hour forecast: `https://api.openweathermap.org/data/2.5/forecast`

Forecast availability and request limits depend on your OpenWeather account/product subscription. This project requests the 5-day forecast endpoint and shows a real provider error if it is unavailable; it does not fabricate forecast data.

## 2. Configure environment variables

Copy `.env.example` to `.env`.

Windows PowerShell:
```powershell
Copy-Item .env.example .env
```

macOS/Linux:
```bash
cp .env.example .env
```

Edit `.env` and set:
```dotenv
OPENWEATHER_API_KEY=your_real_key
MONGODB_URI=mongodb+srv://your_user:your_password@your-cluster.example.mongodb.net/?retryWrites=true&w=majority
MONGODB_DATABASE=weather_dashboard
```

Never commit `.env` or publish API keys/credentials. `.gitignore` already excludes `.env`.

## 3. Install and run locally

Windows PowerShell:
```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
python app.py
```

macOS/Linux:
```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000.

If PowerShell blocks activation, you can run `.venv\Scripts\python.exe -m pip install -r requirements.txt` and `.venv\Scripts\python.exe app.py` without activating the environment.

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/` | Dashboard UI |
| GET | `/api/health` | Reports whether the API key is configured and MongoDB is reachable |
| GET | `/api/weather?city=Pune` | Fetches live current weather and forecast, then attempts to store a history entry |
| GET | `/api/history` | Returns recent saved searches |
| DELETE | `/api/history` | Deletes all search-history records after user confirmation in the UI |
| GET | `/api/favorites` | Returns saved favorite cities |
| POST | `/api/favorites` | Saves a favorite city (`{"city": "Tokyo"}`); resolves name/snapshot via live API when configured |
| DELETE | `/api/favorites?city=Tokyo` | Removes one favorite city (case-insensitive) |

A successful weather response includes `history_saved`. If MongoDB is unavailable, live weather can still render, but the API response indicates that the search could not be stored. The history endpoint returns a clear error instead of pretending the database works.

## Database schema

Database: `weather_dashboard`  
Collection: `search_history`

Example document (values are illustrative):
```json
{
  "city": "Pune",
  "state": "Maharashtra",
  "country": "IN",
  "temperature": 29.5,
  "condition": "Clouds",
  "description": "Scattered clouds",
  "humidity": 65,
  "wind_speed": 11.5,
  "searched_at": "MongoDB BSON Date in UTC"
}
```

The application stores `searched_at` as a BSON Date, not a string. The collection receives a descending index on `searched_at`.

## Testing

Run the tests:
```bash
pytest -q
```

The tests cover page rendering, empty/oversized/invalid city input, service-error handling,
hourly payload structure, wind-direction labels, history deduplication/limits/icons,
favorites CRUD/duplicates/limits, graceful MongoDB/API-key failure modes, and the health
endpoint. External API and database interactions are mocked; they do not call OpenWeather
or require live credentials.

Manual integration checklist:
1. Visit `/api/health`; confirm `weather_api_configured: true` and `database: connected`.
2. Search for a known city such as `Pune`.
3. Confirm current weather and forecast render from API responses.
4. Refresh the page and verify the recent search is still present (persistence check).
5. Click a history entry and verify it searches again.
6. Try an invalid city and confirm an error is shown without a fake weather result.
7. Use the clear-history action and verify the history is empty.
8. Temporarily use an invalid API key and verify the UI reports a configuration/provider error.

## Deployment notes

A compatible WSGI host can run:
```bash
gunicorn app:app
```

Configure `OPENWEATHER_API_KEY`, `MONGODB_URI`, and `MONGODB_DATABASE` as host environment variables. Do not upload `.env` to the host or repository. Set Atlas Network Access to permit the deployed service's outbound IPs; if the host uses changing outbound IPs, choose a secure network strategy supported by your hosting provider.

## Troubleshooting

- **API key missing/rejected:** verify `.env` spelling and that the key is active. Newly issued keys may take some time to activate.
- **City not found:** check spelling; try including state/country, e.g. `Aurangabad, Maharashtra, IN`.
- **MongoDB unavailable:** verify the Atlas URI, database user password, IP access list, and cluster status.
- **Special characters in password:** percent-encode reserved characters in the URI credentials.
- **Forecast endpoint error:** check that your OpenWeather account has access to the 5-day forecast endpoint and that request limits have not been exceeded.
- **External font/icons:** the page uses Google Fonts and OpenWeather icon images; the app remains functional if fonts fail to load, but icons require network access.

## Data and security notes

- Search history is shared by all visitors to this demo because authentication/user-specific history is not part of the brief. Do not store sensitive information in this collection.
- The clear-history endpoint clears the entire shared collection. If deploying publicly, add authentication/authorization or remove this endpoint before production.
- For a public deployment, add rate limiting, CSRF protections for state-changing routes, production logging, and authentication as appropriate.
