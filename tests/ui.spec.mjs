// End-to-end UI tests on index.html (desktop and mobile projects).
import fs from 'node:fs';
import { test, expect, pageSizes } from './helpers.mjs';
import { fixtureFiles } from './fixtures.mjs';

let F;
test.beforeAll(async () => { F = await fixtureFiles(); });

test.beforeEach(async ({ page }) => {
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-app', 'ready');
});

test.afterEach(async ({ page }) => {
  expect(page.errors).toEqual([]);
});

async function compressFile(page, file) {
  await page.setInputFiles('#compress-input', file);
  await expect(page.locator('#compress-name')).toHaveText(file.split('/').pop());
  await page.click('#compress-btn');
  await expect(page.locator('body')).toHaveAttribute('data-compress', /done|unchanged|error/, { timeout: 90_000 });
}

test('starts simple: one action, advanced settings collapsed', async ({ page }) => {
  await expect(page.locator('#compress-btn')).toBeDisabled();
  await expect(page.locator('input[name="level"][value="balanced"]')).toBeChecked();
  await expect(page.locator('#advanced')).not.toHaveAttribute('open', '');
  await expect(page.locator('#opt-dpi')).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});

test('compresses a PDF and downloads a smaller valid file', async ({ page }) => {
  await compressFile(page, F.photo);
  await expect(page.locator('body')).toHaveAttribute('data-compress', 'done');
  await expect(page.locator('#compress-headline')).toContainText('% smaller');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#compress-download')]);
  expect(download.suggestedFilename()).toBe('photo-compressed.pdf');
  const bytes = fs.readFileSync(await download.path());
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.length).toBeLessThan(fs.statSync(F.photo).size / 3);
  expect(await pageSizes(bytes)).toEqual(await pageSizes(fs.readFileSync(F.photo)));
});

test('reports when a file is already optimized instead of growing it', async ({ page }) => {
  await compressFile(page, F.photo);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#compress-download')]);
  const once = `${F.photo}.ui-once.pdf`;
  fs.copyFileSync(await download.path(), once);
  await compressFile(page, once);
  await expect(page.locator('body')).toHaveAttribute('data-compress', 'unchanged');
  await expect(page.locator('#compress-headline')).toHaveText('Already well optimized');
  await expect(page.locator('#compress-download')).toBeHidden();
});

test('shows a clear error for files that are not PDFs', async ({ page }) => {
  await compressFile(page, F.notPdf);
  await expect(page.locator('#compress-error')).toContainText('not a PDF');
});

test('shows a clear error for password-protected PDFs', async ({ page }) => {
  await compressFile(page, F.encrypted);
  await expect(page.locator('#compress-error')).toContainText('password-protected');
});

test('advanced settings follow the level and remember choices', async ({ page }) => {
  await page.click('#advanced summary');
  const dpi = page.locator('#opt-dpi');
  await expect(dpi).toBeVisible();
  await expect(page.locator('#custom-badge')).toBeHidden();
  await dpi.fill('300');
  await expect(page.locator('#opt-dpi-out')).toHaveText('300 dpi');
  await expect(page.locator('#custom-badge')).toBeVisible();
  await page.click('label.level:has(input[value="strong"])');
  await expect(page.locator('#custom-badge')).toBeHidden();
  const strongDpi = await page.evaluate(() => window.PDFMini.LEVELS.strong.dpi);
  await expect(dpi).toHaveValue(String(strongDpi));
  await page.check('#opt-gray');
  await page.reload();
  await expect(page.locator('input[name="level"][value="strong"]')).toBeChecked();
  await expect(page.locator('#opt-gray')).toBeChecked();
  await page.click('#advanced summary');
  await page.click('#opt-reset');
  await expect(page.locator('#opt-gray')).not.toBeChecked();
  await expect(page.locator('#custom-badge')).toBeHidden();
});

test('combines files in the chosen order', async ({ page }) => {
  await page.click('#tab-combine');
  await page.setInputFiles('#combine-input', [F.letter, F.a4, F.a5]);
  await expect(page.locator('#combine-summary')).toHaveText('3 files · 4 pages · ' + /\S+ \S+$/.exec(await page.locator('#combine-summary').textContent())[0]);
  await page.click('button[aria-label="Move a5.pdf up"]');
  await page.click('button[aria-label="Remove letter.pdf"]');
  await expect(page.locator('#combine-list .file-name')).toHaveText(['a5.pdf', 'a4.pdf']);
  await expect(page.locator('#combine-btn')).toBeEnabled();
  await page.click('#combine-btn');
  await expect(page.locator('body')).toHaveAttribute('data-combine', 'done');
  await expect(page.locator('#combine-sizes')).toContainText('3 pages');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#combine-download')]);
  expect(download.suggestedFilename()).toBe('combined.pdf');
  const sizes = await pageSizes(fs.readFileSync(await download.path()));
  expect(sizes).toEqual([[420, 595, 0], [595, 842, 0], [595, 842, 0]]);

  // Hand the result to the compressor.
  await page.click('#combine-compress');
  await expect(page.locator('#tab-compress')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#compress-name')).toHaveText('combined.pdf');
  await expect(page.locator('#compress-btn')).toBeEnabled();
});

test('combine refuses files it cannot read', async ({ page }) => {
  await page.click('#tab-combine');
  await page.setInputFiles('#combine-input', [F.letter, F.encrypted]);
  await expect(page.locator('#combine-list')).toContainText('password-protected');
  await expect(page.locator('#combine-btn')).toBeDisabled();
  await page.click('button[aria-label="Remove encrypted.pdf"]');
  await page.setInputFiles('#combine-input', [F.a4]);
  await expect(page.locator('#combine-btn')).toBeEnabled();
});

test('tabs work with the keyboard', async ({ page, isMobile }) => {
  test.skip(isMobile, 'no hardware keyboard');
  await page.focus('#tab-compress');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tab-combine')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tab-combine')).toBeFocused();
  await expect(page.locator('#panel-combine')).toBeVisible();
  await expect(page.locator('#panel-compress')).toBeHidden();
});

test('dropping a file anywhere on the page selects it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'drag and drop is a desktop interaction');
  const b64 = fs.readFileSync(F.photo).toString('base64');
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dropped.pdf', { type: 'application/pdf' }));
    document.querySelector('footer').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, b64);
  await expect(page.locator('#compress-name')).toHaveText('dropped.pdf');
});

test('controls are large enough to tap', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'mobile layout check');
  await page.setInputFiles('#compress-input', F.photo);
  for (const sel of ['#tab-compress', '#tab-combine', '#compress-btn', 'label.level >> nth=0', '#advanced summary']) {
    const box = await page.locator(sel).boundingBox();
    expect(box.height, sel).toBeGreaterThanOrEqual(40);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});

test('warns that a digital signature will not survive', async ({ page }) => {
  await compressFile(page, F.signed);
  await expect(page.locator('#compress-note')).toBeVisible();
  await expect(page.locator('#compress-note')).toContainText('digitally signed');
  await compressFile(page, F.photo);
  await expect(page.locator('#compress-note')).toBeHidden();
});

test('the file chooser is reachable and visible with the keyboard', async ({ page, isMobile }) => {
  test.skip(isMobile, 'no hardware keyboard');
  await page.focus('#tab-compress');
  await page.keyboard.press('Tab');
  await expect(page.locator('#compress-input')).toBeFocused();
  const outline = await page.locator('#compress-drop').evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe('none');
});

test('changing settings clears a result made with the old settings', async ({ page }) => {
  await compressFile(page, F.photo);
  await expect(page.locator('#compress-result')).toBeVisible();
  await page.click('label.level:has(input[value="strong"])');
  await expect(page.locator('#compress-result')).toBeHidden();
  await expect(page.locator('body')).toHaveAttribute('data-compress', 'ready');
  await page.click('#compress-btn');
  await expect(page.locator('body')).toHaveAttribute('data-compress', 'done');
  await expect(page.locator('#compress-dl')).toContainText(`${await page.evaluate(() => window.PDFMini.LEVELS.strong.dpi)} dpi`);
});
