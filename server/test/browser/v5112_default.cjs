const { chromium } = require('playwright')
;(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=user-gesture-required'],
  })
  for (let run = 1; run <= 3; run++) {
    const ctx = await browser.newContext({ permissions: ['microphone'] })
    const page = await ctx.newPage()
    let opened = false
    let chosenHost = null
    page.on('console', m => {
      const t = m.text()
      if (t.includes('MIXER_JOIN_ACK received')) opened = true
      const m2 = t.match(/wss?:\/\/([\w.-]+)\/mixer/)
      if (m2) chosenHost = m2[1]
    })
    await page.goto('https://tonel.io/', { waitUntil: 'domcontentloaded', timeout: 25000 })
    await page.waitForTimeout(2500)
    const heroBefore = await page.evaluate(() =>
      document.querySelector('.v1-num')?.firstChild?.textContent?.trim())
    await page.locator('button:has-text("免费创建房间")').first().click()
    await page.locator('.modal button:has-text("创建")').first().click()
    await page.waitForURL(/\/room\//, { timeout: 15000 })
    await page.waitForTimeout(5000)
    const banner = await page.evaluate(() => {
      const errSpans = [...document.querySelectorAll('span')].map(e => e.textContent || '')
      const fallbackBanners = [...document.querySelectorAll('[role=status]')].map(e => e.textContent || '')
      return {
        err: errSpans.find(t => t.includes('麦克风/音频') || t.includes('混音服务器连接失败')) || null,
        fallback: fallbackBanners.find(t => t.includes('备用服务器')) || null,
      }
    })
    console.log(`run ${run}: ${opened ? 'OK ' : 'BAD'} host=${chosenHost} hero=${heroBefore}` +
                (banner.err ? ` ERR="${banner.err.slice(0, 60)}"` : '') +
                (banner.fallback ? ' [fallback-hint-shown]' : ''))
    await ctx.close()
  }
  await browser.close()
})().catch(e => { console.error('FAIL', e); process.exit(1) })
