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

### Added
- **`safeClick` Helper:** Restored and improved the click helper to handle stubborn elements with fallback strategies (force click, evaluate click).
- **Run Script:** Restored `run.bat` for easy launching on Windows.
- **Brain Module:** Verified and restored core AI logic in `brain.js`.

### Changed
- **Performance:** Optimized the main event loop to reduce unnecessary page navigations and API calls.
- **Logging:** Enhanced console output for better debugging of matching logic and scraper errors.
