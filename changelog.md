# Century Solver Changelog

## [1.2.0] - 2026-02-12

### Fixed
- **Drag & Drop Reliability:** 
  - Resolved `ElementHandle.dragTo is not a function` error by implementing a custom low-level `safeDrag` helper.
  - Added robust checks for element visibility and scrolling before interaction.
  - Implemented a verification loop that retries drag operations up to 3 times if target slots remain empty.
- **Assignment Scraping:**
  - Fixed an issue where the scraper would aggressively refresh the page in the background, causing interruption.
  - Implemented smarter "white screen" detection that only refreshes if the page is truly empty (no text/elements).
  - Added a 3-attempt retry mechanism with delays for initial assignment loading.
- **Nugget Transitions:**
  - Implemented an "Aggressive Jump" feature that transitions to the next nugget immediately when accuracy/feedback is detected.
  - Added logic to detect and dismiss "Your answer has been submitted!" overlays that block navigation.
  - Expanded button detection to handle varying text casing (e.g., "NEXT QUESTION" vs "Next Question").
- **Question Type Support:**
  - Added support for Dropdown/Select inputs (common in "Additional Answers" sections).
  - The solver can now identify standard `<select>` elements and custom `.rc-dropdown` components.

### Added
- **`safeClick` Helper:** Restored and improved the click helper to handle stubborn elements with fallback strategies (force click, evaluate click).
- **Run Script:** Restored `run.bat` for easy launching on Windows.
- **Brain Module:** Verified and restored core AI logic in `brain.js`.

### Changed
- **Performance:** Optimized the main event loop to reduce unnecessary page navigations and API calls.
- **Logging:** Enhanced console output for better debugging of matching logic and scraper errors.

### Security
- **Environment Variables:** Implemented `dotenv` for credential management. API keys and login details can now be stored in a `.env` file.
- **Git Protection:** Added a `.gitignore` file to ensure sensitive configurations and log files are not accidentally committed to GitHub.
- **Template Provided:** Added `.env.example` to guide setup for new environments.
