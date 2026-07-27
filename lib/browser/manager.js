import path from "node:path"
import os from "node:os"
import fs from "node:fs"
import { pathToFileURL } from "node:url"
import lodash from "lodash"
import { chromium } from "playwright"
import cfg from "../config/config.js"

const cwd = process.cwd()

export class BrowserManager {
    constructor(config = {}) {
        this.browser = null
        this.lock = false
        this.shoting = []
        this.renderNum = 0
        this.restartNum = 100
        this.browserServer = null
        this.context = null
        this.closing = false
        this.browserIdleTimer = null
        this.defaultConfig = {
            browserType: "chromium",
            headless: true,
            browserIdleTimeout: 300000,
            args: [
                "--disable-gpu",
                "--disable-setuid-sandbox",
                "--no-sandbox",
                "--no-zygote"
            ],
            pageGotoParams: {
                timeout: 120000,
                waitUntil: "networkidle"
            }
        }
        this.configure(config)
    }

    configure(config = {}) {
        this.runtimeConfig = {
            ...this.defaultConfig,
            ...config
        }
        this.launchOptions = {
            headless: config.headless ?? this.defaultConfig.headless,
            args: config.args || this.defaultConfig.args
        }
        const executablePath = config.chromiumPath || cfg?.bot?.chromium_path
        if (executablePath) {
            if (fs.existsSync(executablePath)) {
                this.launchOptions.executablePath = executablePath
            } else {
                logger.warn(`chromium 路径不存在，已回退到 Playwright 默认浏览器：${executablePath}`)
            }
        }

        this.wsEndpoint = config.playwrightWS || config.puppeteerWS || cfg?.bot?.playwright_ws || cfg?.bot?.puppeteer_ws
        this.connectProtocol = config.puppeteerWS || cfg?.bot?.puppeteer_ws ? "cdp" : config.connectProtocol
        this.pageGotoParams = {
            ...this.defaultConfig.pageGotoParams,
            ...(config.pageGotoParams || {})
        }
        const browserIdleTimeout = Number(config.browserIdleTimeout ?? this.defaultConfig.browserIdleTimeout)
        this.browserIdleTimeout = Number.isFinite(browserIdleTimeout) && browserIdleTimeout > 0 ? browserIdleTimeout : 0
        this.browserTimeout =
            config.playwrightTimeout ||
            config.puppeteerTimeout ||
            cfg?.bot?.playwright_timeout ||
            cfg?.bot?.puppeteer_timeout ||
            0
    }

    clearBrowserIdleTimer() {
        if (this.browserIdleTimer) {
            clearTimeout(this.browserIdleTimer)
            this.browserIdleTimer = null
        }
    }

    scheduleBrowserIdleTimer() {
        this.clearBrowserIdleTimer()
        if (!this.browserIdleTimeout || !this.browser || this.lock || this.shoting.length > 0) {
            return
        }

        this.browserIdleTimer = setTimeout(() => {
            this.browserIdleTimer = null
            if (!this.browser || this.lock || this.shoting.length > 0) {
                return
            }
            this.stop(this.browser).catch(err => logger.error(err))
        }, this.browserIdleTimeout)
    }

    async browserInit() {
        if (this.browser) {
            return this.browser
        }
        if (this.lock) {
            return false
        }
        this.lock = true

        logger.info("playwright Chromium 启动中...")

        let connectFlag = false
        try {
            const browserUrl = (await this.getCachedEndpoint()) || this.wsEndpoint
            if (browserUrl) {
                const browser = await this.connect(browserUrl, this.connectProtocol)
                if (browser) {
                    this.browser = browser
                    connectFlag = true
                    logger.info(`playwright Chromium 连接成功 ${browserUrl}`)
                }
            }
        } catch (err) {
            logger.error("playwright Chromium 连接失败", err)
            await this.clearCachedEndpoint()
        }

        if (!this.browser || !connectFlag) {
            try {
                this.browser = await chromium.launch(this.launchOptions)
            } catch (err) {
                logger.error("playwright Chromium 启动失败", err)
            }
        }

        this.lock = false

        if (!this.browser) {
            logger.error("playwright Chromium 不可用")
            return false
        }

        if (!connectFlag) {
            const wsEndpoint = this.browser.wsEndpoint?.()
            if (wsEndpoint) {
                logger.info(`playwright Chromium 启动成功 ${wsEndpoint}`)
                await this.cacheEndpoint(wsEndpoint)
            } else {
                logger.info("playwright Chromium 启动成功")
            }
        }

        this.browser.on("disconnected", () => {
            this.browser = null
            this.context = null
            if (this.closing) {
                return
            }
            this.browserInit().catch(err => logger.error("playwright Chromium 重连失败", err))
        })

        return this.browser
    }

    async getBrowserContext() {
        const browser = await this.browserInit()
        if (!browser) {
            return false
        }
        if (this.context) {
            return this.context
        }

        const contexts = browser.contexts()
        this.context =
            contexts[0] ||
            (await browser.newContext({
                viewport: {
                    width: 1280,
                    height: 720
                }
            }))
        return this.context
    }

    async connect(endpoint, protocol) {
        if (protocol === "cdp" || /^https?:/i.test(endpoint)) {
            return chromium.connectOverCDP(endpoint)
        }
        return chromium.connect(endpoint)
    }

    async screenshot(name, data = {}, hooks = {}) {
        if (!(await this.browserInit())) {
            return false
        }

        const pageHeight = data.multiPageHeight || 4000
        const savePath = await hooks.dealTpl?.(name, data)
        if (!savePath) {
            return false
        }

        const start = Date.now()
        const ret = []
        this.shoting.push(name)
        this.clearBrowserIdleTimer()

        let overtime
        if (this.browserTimeout > 0) {
            overtime = setTimeout(() => {
                if (!this.shoting.length) {
                    return
                }
                logger.error(`[图片生成][${name}] 截图超时，当前等待队列：${this.shoting.join(",")}`)
                this.restart(true)
                this.shoting = []
            }, this.browserTimeout)
        }

        try {
            const context = await this.getBrowserContext()
            const page = await context.newPage()
            const pageGotoParams = {
                ...this.pageGotoParams,
                ...(data.pageGotoParams || {})
            }

            if (pageGotoParams.waitUntil === "networkidle0" || pageGotoParams.waitUntil === "networkidle2") {
                pageGotoParams.waitUntil = "networkidle"
            }

            await page.goto(this.toFileUrl(savePath), pageGotoParams)

            const body = page.locator("#container").first()
            const hasContainer = await body.count()
            const target = hasContainer ? body : page.locator("body").first()
            const boundingBox = await target.boundingBox()

            if (!boundingBox) {
                throw new Error("Failed to measure screenshot target")
            }

            let num = 1
            const screenshotOptions = {
                type: data.imgType || "jpeg",
                omitBackground: data.omitBackground || false,
                quality: data.quality || 90,
                path: data.path || undefined
            }

            if (data.multiPage) {
                screenshotOptions.type = "jpeg"
                num = Math.round(boundingBox.height / pageHeight) || 1
            }

            if (data.imgType === "png") {
                delete screenshotOptions.quality
            }

            if (!data.multiPage) {
                let buff = await target.screenshot(screenshotOptions)
                if (!Buffer.isBuffer(buff)) {
                    buff = Buffer.from(buff)
                }
                this.renderNum++
                const kb = (buff.length / 1024).toFixed(2) + "KB"
                logger.mark(`[图片生成][${name}][${this.renderNum}次] ${kb} ${logger.green(`${Date.now() - start}ms`)}`)
                ret.push(buff)
            } else {
                if (num > 1) {
                    await page.setViewportSize({
                        width: Math.max(Math.ceil(boundingBox.width), 1),
                        height: Math.max(Math.ceil(pageHeight + 100), 1)
                    })
                }

                for (let i = 1; i <= num; i++) {
                    if (i !== 1 && i === num) {
                        await page.setViewportSize({
                            width: Math.max(Math.ceil(boundingBox.width), 1),
                            height: Math.max(Math.ceil(boundingBox.height - pageHeight * (num - 1)), 1)
                        })
                    }

                    if (i !== 1 && i <= num) {
                        await page.evaluate(height => window.scrollBy(0, height), pageHeight)
                    }

                    let buff =
                        num === 1
                            ? await target.screenshot(screenshotOptions)
                            : await page.screenshot(screenshotOptions)

                    if (!Buffer.isBuffer(buff)) {
                        buff = Buffer.from(buff)
                    }

                    if (num > 2) {
                        await Bot.sleep(200)
                    }

                    this.renderNum++
                    const kb = (buff.length / 1024).toFixed(2) + "KB"
                    logger.mark(`[图片生成][${name}][${i}/${num}] ${kb}`)
                    ret.push(buff)
                }

                if (num > 1) {
                    logger.mark(`[图片生成][${name}] 处理完成`)
                }
            }

            await page.close().catch(err => logger.error(err))
        } catch (err) {
            logger.error(`[图片生成][${name}] 图片生成失败`, err)
            await this.restart(true)
            if (overtime) {
                clearTimeout(overtime)
            }
            return false
        } finally {
            if (overtime) {
                clearTimeout(overtime)
            }
            this.shoting = this.shoting.filter(entry => entry !== name)
        }

        if (!ret.length || !ret[0]) {
            logger.error(`[图片生成][${name}] 图片生成为空`)
            return false
        }

        const restarted = this.restart()
        if (!restarted?.then) {
            this.scheduleBrowserIdleTimer()
        } else {
            restarted.then(() => this.scheduleBrowserIdleTimer()).catch(err => logger.error(err))
        }
        return data.multiPage ? ret : ret[0]
    }

    restart(force = false) {
        if (!this.browser?.close || this.lock) {
            return
        }
        if (!force && (this.renderNum % this.restartNum !== 0 || this.shoting.length > 0)) {
            return
        }

        logger.info("playwright Chromium " + (force ? "强制" : "") + "关闭重启...")
        this.stop(this.browser).catch(err => logger.error(err))
        this.browser = null
        this.context = null
        const boot = this.browserInit()
        if (boot?.then) {
            boot.then(() => this.scheduleBrowserIdleTimer()).catch(err => logger.error(err))
        }
        return boot
    }

    async stop(browser = this.browser) {
        this.closing = true
        try {
            await browser?.close()
        } catch (err) {
            logger.error("playwright Chromium 关闭错误", err)
        } finally {
            if (browser === this.browser) {
                this.browser = null
                this.context = null
            }
            this.closing = false
            this.clearBrowserIdleTimer()
        }
    }

    toFileUrl(filePath) {
        const normalizedPath = filePath.replace(/^\.[/\\]/, "")
        return pathToFileURL(path.resolve(cwd, normalizedPath)).toString()
    }

    async getCachedEndpoint() {
        try {
            const mac = this.getMac()
            this.browserMacKey = `Yz:chromium:browserWSEndpoint:${mac}`
            return await redis.get(this.browserMacKey)
        } catch {
            return ""
        }
    }

    async cacheEndpoint(endpoint) {
        if (!this.browserMacKey) {
            return
        }
        try {
            await redis.set(this.browserMacKey, endpoint, {
                EX: 60 * 60 * 24 * 30
            })
        } catch {}
    }

    async clearCachedEndpoint() {
        if (!this.browserMacKey) {
            return
        }
        try {
            await redis.del(this.browserMacKey)
        } catch {}
    }

    getMac() {
        let mac = "00:00:00:00:00:00"
        try {
            const network = os.networkInterfaces()
            let macFlag = false
            for (const adapter in network) {
                for (const item of network[adapter]) {
                    if (item.mac && item.mac !== mac) {
                        macFlag = true
                        mac = item.mac
                        break
                    }
                }
                if (macFlag) {
                    break
                }
            }
        } catch {}
        return mac.replace(/:/g, "")
    }
}
