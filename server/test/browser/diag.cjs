const { chromium } = require('playwright')
;(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=user-gesture-required'],
  })
  const ctx = await browser.newContext({ permissions: ['microphone'] })
  const page = await ctx.newPage()
  page.on('console', m => console.log(`[${m.type()}]`, m.text().slice(0, 250)))
  page.on('pageerror', e => console.log('[PAGEERR]', e.message))
  // Force WSS audio path (matches tonel.io/ behavior)
  await page.goto('https://tonel.io/new?transport=wss', { waitUntil: 'networkidle', timeout: 25000 })
  await page.waitForTimeout(1500)
  console.log('--- click 创建 ---')
  await page.locator('button:has-text("免费创建房间")').first().click()
  await page.locator('.modal button:has-text("创建")').first().click()
  await page.waitForURL(/\/room\//, { timeout: 15000 })
  console.log('--- in room ---')
  await page.waitForTimeout(8000)
  const out = await page.evaluate(() => {
    const lines = document.body.innerText.split('\n').filter(l => l.match(/uid=|失败|ring=|启用麦克风/))
    return lines
  })
  console.log('--- final state ---')
  console.log(out.join('\n'))
  await browser.close()
})().catch(e => { console.error('FAIL', e); process.exit(1) })
