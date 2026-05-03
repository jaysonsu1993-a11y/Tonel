// Verify v5.1.8 didn't break the first-time room entry path.
// Runs 5 cold sessions, each with a fresh browser context (no permission
// pre-granted -> Playwright auto-grants on prompt). Counts how many show
// the error banner / how many recover after one click / two clicks.

const { chromium } = require('playwright')
const URL = process.argv.find(a => a.startsWith('--url='))?.slice(6) || 'https://tonel.io/new'
const TRIES = parseInt(process.argv.find(a => a.startsWith('--tries='))?.slice(8) || '3', 10)

;(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=user-gesture-required',
    ],
  })

  let stats = { ok: 0, oneClick: 0, twoClick: 0, broken: 0 }
  for (let i = 1; i <= TRIES; i++) {
    const ctx = await browser.newContext({ permissions: ['microphone'] })
    const page = await ctx.newPage()
    const events = []
    page.on('console', m => {
      const t = m.text()
      if (m.type() === 'error' || /Mixer|Audio|Init|getUserMedia|AudioContext|WebSocket|Cleaning/.test(t)) {
        events.push(`[${m.type()}] ${t.slice(0, 180)}`)
      }
    })

    await page.goto(URL, { waitUntil: 'networkidle', timeout: 25000 })
    await page.waitForTimeout(2000)
    await page.locator('button:has-text("免费创建房间")').first().click()
    await page.locator('.modal button:has-text("创建")').first().click()
    await page.waitForURL(/\/room\//, { timeout: 15000 })

    const readState = async (label) => {
      await page.waitForTimeout(2500)
      const s = await page.evaluate(() => {
        const errSpans = [...document.querySelectorAll('span')]
          .map(e => e.textContent || '').filter(Boolean)
        const banner = errSpans.find(t => t.includes('麦克风/音频初始化失败') || t.includes('混音服务器连接失败'))
        const e2e = document.querySelector('.latency-value:not(.latency-rtt)')?.textContent?.trim()
        const rtt = document.querySelector('.latency-value.latency-rtt')?.textContent?.trim()
        const dbg = document.body.innerText.split('\n').find(l => l.startsWith('uid=') && l.includes('ring=')) || ''
        const ws = dbg.match(/ws=(\w+)/)?.[1]
        return { banner, e2e, rtt, ws }
      })
      console.log(`run ${i} [${label}]:`, JSON.stringify(s))
      return s
    }

    const a = await readState('mount')
    let outcome
    if (!a.banner && a.ws !== 'null' && a.ws !== 'CLOSED') {
      outcome = 'ok'
    } else {
      // try to recover via clicks
      const tryClick = async () => {
        const btn = page.locator('button:has-text("启用麦克风")').first()
        try { await btn.click({ timeout: 3000 }) } catch { return false }
        return true
      }
      if (!(await tryClick())) { outcome = 'broken'; }
      else {
        const b = await readState('click1')
        if (!b.banner) outcome = 'oneClick'
        else {
          if (!(await tryClick())) { outcome = 'broken'; }
          else {
            const c = await readState('click2')
            outcome = c.banner ? 'broken' : 'twoClick'
          }
        }
      }
    }
    console.log(`  → outcome: ${outcome}\n`)
    stats[outcome]++
    await ctx.close()
  }
  await browser.close()
  console.log('=== summary ===')
  console.log(JSON.stringify(stats))
  process.exit(stats.broken > 0 || stats.twoClick > 0 ? 1 : 0)
})().catch(e => { console.error('FAIL', e.stack || e); process.exit(2) })
