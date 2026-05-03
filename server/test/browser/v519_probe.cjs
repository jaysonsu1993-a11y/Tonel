// Verify v5.1.9 against locally-served preview build, hitting srv-new
// (Aliyun, IP-reachable). Forces WSS path to mirror tonel.io/ behavior.
// Runs 3 cold sessions; expects every one to enter the room cleanly
// with no banner.
const { chromium } = require('playwright')

const TRIES = 3
const PREVIEW = 'http://127.0.0.1:4173/new?transport=wss'

;(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=user-gesture-required'],
  })
  let bad = 0
  for (let i = 1; i <= TRIES; i++) {
    const ctx = await browser.newContext({ permissions: ['microphone'] })
    const page = await ctx.newPage()
    let banner = null
    let opened = false
    page.on('console', m => {
      const t = m.text()
      if (/MIXER_JOIN_ACK received/.test(t)) opened = true
    })
    await page.goto(PREVIEW, { waitUntil: 'networkidle', timeout: 25000 })
    await page.waitForTimeout(1500)
    await page.locator('button:has-text("免费创建房间")').first().click()
    await page.locator('.modal button:has-text("创建")').first().click()
    await page.waitForURL(/\/room\//, { timeout: 15000 })
    await page.waitForTimeout(5000)
    banner = await page.evaluate(() =>
      [...document.querySelectorAll('span')].map(e => e.textContent || '')
        .find(t => t.includes('麦克风/音频初始化失败') || t.includes('混音服务器连接失败')) || null)
    const verdict = (banner || !opened) ? 'BAD ' : 'OK  '
    console.log(`run ${i}/${TRIES}: ${verdict}` +
                (banner ? ` banner="${banner.slice(0, 80)}"` : '') +
                ` opened=${opened}`)
    if (verdict === 'BAD ') bad++
    await ctx.close()
  }
  await browser.close()
  console.log(`\nresult: ${TRIES - bad}/${TRIES} OK`)
  process.exit(bad === 0 ? 0 : 1)
})().catch(e => { console.error('FAIL', e.stack || e); process.exit(2) })
