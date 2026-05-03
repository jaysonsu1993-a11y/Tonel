const { chromium } = require('playwright')

const SCENARIOS = [
  { url: 'https://tonel.io/?host=aliyun',                  label: 'forced-aliyun (simulates fallback)' },
  { url: 'https://tonel.io/?host=kufan&transport=wss',     label: 'forced-kufan (primary path)' },
  { url: 'https://tonel.io/new?transport=wss',             label: '/new path (always Aliyun)' },
]

;(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=user-gesture-required'],
  })
  for (const s of SCENARIOS) {
    const ctx = await browser.newContext({ permissions: ['microphone'] })
    const page = await ctx.newPage()
    let opened = false
    let host = null
    page.on('console', m => {
      const t = m.text()
      if (t.includes('MIXER_JOIN_ACK received')) opened = true
      const m2 = t.match(/wss?:\/\/([\w.-]+)\//)
      if (m2 && (m2[1].includes('tonel.io'))) host = m2[1]
    })
    await page.goto(s.url, { waitUntil: 'domcontentloaded', timeout: 25000 })
    await page.waitForTimeout(2000)
    await page.locator('button:has-text("免费创建房间")').first().click()
    await page.locator('.modal button:has-text("创建")').first().click()
    await page.waitForURL(/\/room\//, { timeout: 15000 })
    await page.waitForTimeout(5000)
    const banner = await page.evaluate(() =>
      [...document.querySelectorAll('span'), ...document.querySelectorAll('div[role=status]')]
        .map(e => e.textContent || '')
        .find(t => t.includes('混音服务器') || t.includes('备用服务器') || t.includes('麦克风/音频')) || null)
    console.log(`${s.label}: ${opened ? 'OK ' : 'BAD'} host=${host || '?'}` +
                (banner ? ` banner="${banner.slice(0, 60)}"` : ''))
    await ctx.close()
  }
  await browser.close()
})().catch(e => { console.error('FAIL', e.stack || e); process.exit(2) })
