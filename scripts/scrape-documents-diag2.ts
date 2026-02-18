#!/usr/bin/env npx tsx
/**
 * 법원경매 송달/문건 진단 v2
 *
 * 핵심 가설: WebSquare 프레임워크가 자체적으로 API를 호출하면
 * IP 차단이 적용되지 않을 수 있음.
 *
 * 테스트:
 * 1. setSrc로 사건 상세 페이지 열기
 * 2. 페이지/프레임 내부 탭 구조 탐색
 * 3. WebSquare 탭 클릭 시도 → 네트워크 인터셉트
 * 4. 직접 fetch 비교 (헤더 차이 확인)
 */

import { chromium, type Page, type Frame } from 'playwright';
import fs from 'fs';
import path from 'path';

const SEARCH_PAGE = 'https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml';
const DETAILS_FILE = path.join(process.cwd(), 'data', 'court-auction-details.json');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface DetailEntry { cortOfcCd: string; csNo: string; courtName: string; caseNumber: string; [key: string]: any; }

// ======= 네트워크 캡처 =======
interface CapturedRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    timestamp: number;
}

interface CapturedResponse {
    url: string;
    status: number;
    body: string;
    timestamp: number;
}

const capturedRequests: CapturedRequest[] = [];
const capturedResponses: CapturedResponse[] = [];

function setupNetworkCapture(page: Page) {
    page.on('request', (req) => {
        if (req.url().includes('.on') && req.method() === 'POST') {
            const url = req.url().replace('https://www.courtauction.go.kr/pgj/', '');
            const headers = req.headers();
            const postData = req.postData() || '';

            capturedRequests.push({
                url,
                method: req.method(),
                headers,
                body: postData,
                timestamp: Date.now(),
            });

            console.log(`  [REQ] ${url}`);
            console.log(`    body: ${postData.slice(0, 300)}`);
            // 중요 헤더 출력
            const importantHeaders = ['referer', 'origin', 'x-requested-with', 'cookie', 'content-type'];
            for (const h of importantHeaders) {
                if (headers[h]) console.log(`    ${h}: ${headers[h].slice(0, 100)}`);
            }
        }
    });

    page.on('response', async (res) => {
        if (res.url().includes('.on')) {
            const url = res.url().replace('https://www.courtauction.go.kr/pgj/', '');
            try {
                const text = await res.text();
                const status = res.status();

                capturedResponses.push({
                    url,
                    status,
                    body: text.slice(0, 1000),
                    timestamp: Date.now(),
                });

                console.log(`  [RES] ${url} → ${status} (${text.length}b)`);
                if (text.includes('ipcheck') || text.includes('차단') || status !== 200) {
                    console.log(`    preview: ${text.slice(0, 300)}`);
                }
                // 송달/문건 API 응답이면 상세 출력
                if (url.includes('DlvrOfdoc') || url.includes('dlvr')) {
                    console.log(`    [FULL] ${text.slice(0, 500)}`);
                }
            } catch { /* ignore */ }
        }
    });
}

// ======= 메인 =======
async function main() {
    console.log('=== 송달/문건 API 진단 v2: WebSquare 탭 클릭 방식 ===\n');

    if (!fs.existsSync(DETAILS_FILE)) {
        console.error('court-auction-details.json 없음: ' + DETAILS_FILE);
        process.exit(1);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawData: Record<string, any> = JSON.parse(fs.readFileSync(DETAILS_FILE, 'utf-8'));
    const details: DetailEntry[] = Array.isArray(rawData) ? rawData : Object.values(rawData);

    // 진행된 사건 선택
    const advanced = details.filter(d =>
        d.investigation?.dma_curstExmnMngInf && Object.keys(d.investigation.dma_curstExmnMngInf).length > 0
    );
    const target = advanced[0];
    if (!target) { console.error('테스트 사건 없음'); process.exit(1); }

    console.log(`테스트: ${target.caseNumber} (${target.courtName})`);
    console.log(`  cortOfcCd=${target.cortOfcCd}, csNo=${target.csNo}\n`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        locale: 'ko-KR',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: { width: 1400, height: 900 },
    });
    const page = await context.newPage();

    // 세션 확보
    console.log('세션 확보 중...');
    await page.goto(SEARCH_PAGE, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    const wsReady = await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const main = (window as any).$p?.main?.();
        return !!main?.wfm_mainFrame?.setSrc;
    });

    if (!wsReady) { console.error('WebSquare 초기화 실패'); await browser.close(); process.exit(1); }
    console.log('세션 확보 완료\n');

    // 네트워크 캡처 시작
    setupNetworkCapture(page);

    // ========================================
    // 테스트 1: setSrc로 사건 상세 페이지 열기
    // ========================================
    console.log('=== 1. setSrc → PGJ15AF01.xml (사건 상세) ===');
    await page.evaluate((params: { csNo: string; cortOfcCd: string }) => {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const main = (window as any).$p?.main?.();
            const wfm = main?.wfm_mainFrame;
            if (wfm?.setSrc) {
                wfm.setSrc('/pgj/ui/pgj100/PGJ15AF01.xml', {
                    dataObject: {
                        type: 'json',
                        name: 'param',
                        data: {
                            sideDvsCd: '',
                            menuNm: '',
                            userCsNo: '',
                            csNo: params.csNo,
                            cortOfcCd: params.cortOfcCd,
                            srchInfo: '',
                            prevInfo: '',
                        },
                    },
                });
            }
        } catch { /* ignore */ }
    }, { csNo: target.csNo, cortOfcCd: target.cortOfcCd });

    await page.waitForTimeout(5000);

    // ========================================
    // 테스트 2: 프레임 구조 탐색 + 탭 탐색
    // ========================================
    console.log('\n=== 2. 프레임 + 탭 구조 탐색 ===');
    const frames = page.frames();
    console.log(`  총 frames: ${frames.length}`);

    let caseDetailFrame: Frame | null = null;
    for (let fi = 0; fi < frames.length; fi++) {
        const f = frames[fi];
        const fUrl = f.url();
        console.log(`  frame[${fi}]: ${fUrl.slice(0, 100)}`);
        if (fUrl.includes('PGJ15A')) {
            caseDetailFrame = f;
            console.log(`    → 사건 상세 프레임 발견!`);
        }
    }

    if (!caseDetailFrame) {
        console.log('\n  사건 상세 프레임을 찾지 못함. 메인 페이지에서 탐색...');
        // 메인 페이지 자체에서 탐색
        const mainPageInfo = await page.evaluate(() => {
            const results: string[] = [];
            const body = document.body?.innerText || '';
            results.push(`body length: ${body.length}`);
            if (body.includes('송달')) results.push(`'송달' found`);
            if (body.includes('문건')) results.push(`'문건' found`);

            // 모든 iframe src
            document.querySelectorAll('iframe').forEach((iframe, i) => {
                results.push(`  iframe[${i}] src="${iframe.src}" name="${iframe.name}"`);
            });
            return results;
        });
        mainPageInfo.forEach(line => console.log(`    ${line}`));
    }

    // ========================================
    // 테스트 3: 프레임 내부 상세 탐색
    // ========================================
    const targetFrame = caseDetailFrame || page.mainFrame();
    console.log(`\n=== 3. ${caseDetailFrame ? '사건 상세 프레임' : '메인 프레임'} 내부 탐색 ===`);

    const frameInfo = await targetFrame.evaluate(() => {
        const results: string[] = [];

        // 1. 모든 ID가 있는 요소 (tab/tac/dlvr/ofdoc 관련)
        const relevantIds: string[] = [];
        const allIds: string[] = [];
        document.querySelectorAll('[id]').forEach(el => {
            if (el.id) {
                allIds.push(el.id);
                if (el.id.includes('tac') || el.id.includes('tab') || el.id.includes('dlvr') ||
                    el.id.includes('ofdoc') || el.id.includes('Tab') || el.id.includes('wfm')) {
                    relevantIds.push(`${el.id} <${el.tagName.toLowerCase()}>`);
                }
            }
        });
        results.push(`relevant IDs (${relevantIds.length}): ${relevantIds.join(', ')}`);
        results.push(`all IDs (${allIds.length}): ${allIds.slice(0, 80).join(', ')}`);

        // 2. 송달/문건 텍스트 + 클릭 가능 요소
        const clickable = document.querySelectorAll('a, button, [onclick], [role="tab"], span, div');
        const deliveryClickable: string[] = [];
        clickable.forEach(el => {
            const text = el.textContent?.trim() || '';
            if (text.includes('송달') || text.includes('문건') || text.includes('기일')) {
                const tag = el.tagName.toLowerCase();
                deliveryClickable.push(`<${tag}> id="${el.id}" class="${el.className?.toString().slice(0, 40)}" text="${text.slice(0, 60)}"`);
            }
        });
        results.push(`delivery-related clickable: ${deliveryClickable.length}`);
        deliveryClickable.forEach(c => results.push(`  ${c}`));

        // 3. WebSquare $p 탐색
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        const wp = w.$p;
        if (wp) {
            const keys = Object.keys(wp).filter(k => typeof wp[k] === 'function' || typeof wp[k] === 'object');
            results.push(`$p keys: ${keys.slice(0, 20).join(', ')}`);

            // getComponentById 시도
            if (wp.getComponentById) {
                const tryIds = ['tac_csInfo', 'tac_csDtl', 'tabControl', 'tab_main', 'tacCsDtl',
                    'tac_dlvr', 'tac_ofdoc', 'tab_dlvrOfdoc', 'tac_csDtlInfo'];
                for (const tid of tryIds) {
                    const comp = wp.getComponentById(tid);
                    if (comp) {
                        results.push(`  component '${tid}': ${typeof comp}`);
                        if (comp.getTabCount) results.push(`    tabCount: ${comp.getTabCount()}`);
                        if (comp.getSelectedTabIndex) results.push(`    selectedTab: ${comp.getSelectedTabIndex()}`);
                        // 탭 이름 가져오기
                        if (comp.getTabCount && comp.getTabTitle) {
                            for (let ti = 0; ti < comp.getTabCount(); ti++) {
                                const title = comp.getTabTitle?.(ti) || comp.getTabLabel?.(ti) || '';
                                results.push(`    tab[${ti}]: "${title}"`);
                            }
                        }
                    }
                }
            }

            // WebSquare에서 모든 컴포넌트 나열
            if (wp.getComponentList) {
                try {
                    const list = wp.getComponentList();
                    results.push(`componentList: ${JSON.stringify(list).slice(0, 300)}`);
                } catch { /* ignore */ }
            }
        }

        // 4. 특수 탐색: w2 namespace 속성
        const w2Elems = document.querySelectorAll('[class*="w2tab"], [class*="w2tac"]');
        results.push(`w2tab/w2tac elements: ${w2Elems.length}`);
        w2Elems.forEach((el, i) => {
            if (i < 10) {
                results.push(`  w2[${i}] <${el.tagName}> id="${el.id}" class="${el.className?.toString().slice(0, 60)}"`);
            }
        });

        return results;
    }).catch(e => [`evaluate error: ${String(e).slice(0, 200)}`]);

    frameInfo.forEach(line => console.log(`  ${line}`));

    // ========================================
    // 테스트 4: 탭 클릭 시도 (다양한 방법)
    // ========================================
    console.log('\n=== 4. 탭 클릭 시도 ===');

    // 방법 A: 텍스트 기반 클릭 (Playwright locator)
    console.log('  방법 A: 텍스트 "송달" 클릭 시도');
    try {
        const deliveryTab = targetFrame.locator('text=송달').first();
        const isVisible = await deliveryTab.isVisible({ timeout: 3000 }).catch(() => false);
        if (isVisible) {
            console.log('    "송달" 요소 발견! 클릭 시도...');

            // 클릭 전 네트워크 카운트 기록
            const beforeCount = capturedResponses.length;
            await deliveryTab.click({ timeout: 5000 });
            await page.waitForTimeout(3000);

            // 클릭 후 새로운 응답 확인
            const newResponses = capturedResponses.slice(beforeCount);
            console.log(`    클릭 후 새 응답: ${newResponses.length}개`);
            newResponses.forEach(r => {
                console.log(`      ${r.url} → ${r.status} (${r.body.length}b)`);
                if (r.url.includes('Dlvr') || r.url.includes('dlvr') || r.url.includes('Ofdoc')) {
                    console.log(`      [TARGET RESPONSE] ${r.body.slice(0, 500)}`);
                }
            });
        } else {
            console.log('    "송달" 요소 없음');
        }
    } catch (e) {
        console.log(`    에러: ${String(e).slice(0, 100)}`);
    }

    // 방법 B: "송달/문건" 또는 "문건" 텍스트 클릭
    console.log('  방법 B: 텍스트 "문건" 클릭 시도');
    try {
        const docTab = targetFrame.locator('text=문건').first();
        const isVisible = await docTab.isVisible({ timeout: 3000 }).catch(() => false);
        if (isVisible) {
            console.log('    "문건" 요소 발견! 클릭 시도...');
            const beforeCount = capturedResponses.length;
            await docTab.click({ timeout: 5000 });
            await page.waitForTimeout(3000);
            const newResponses = capturedResponses.slice(beforeCount);
            console.log(`    클릭 후 새 응답: ${newResponses.length}개`);
            newResponses.forEach(r => {
                console.log(`      ${r.url} → ${r.status}`);
                if (r.url.includes('Dlvr') || r.url.includes('dlvr') || r.url.includes('Ofdoc')) {
                    console.log(`      [TARGET RESPONSE] ${r.body.slice(0, 500)}`);
                }
            });
        } else {
            console.log('    "문건" 요소 없음');
        }
    } catch (e) {
        console.log(`    에러: ${String(e).slice(0, 100)}`);
    }

    // 방법 C: WebSquare setSelectedTabIndex
    console.log('  방법 C: WebSquare setSelectedTabIndex 시도');
    const wsTabResult = await targetFrame.evaluate(() => {
        const results: string[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wp = (window as any).$p;
        if (!wp?.getComponentById) {
            results.push('$p.getComponentById 없음');
            return results;
        }

        // 모든 tac_ 접두사 컴포넌트 탐색
        const allIds: string[] = [];
        document.querySelectorAll('[id]').forEach(el => { if (el.id) allIds.push(el.id); });

        const tacIds = allIds.filter(id => id.startsWith('tac') || id.includes('Tab'));
        results.push(`tac/Tab IDs: ${tacIds.join(', ')}`);

        for (const tid of tacIds) {
            const comp = wp.getComponentById(tid);
            if (comp && comp.getTabCount) {
                results.push(`  ${tid}: tabCount=${comp.getTabCount()}, selected=${comp.getSelectedTabIndex?.()}`);

                // 각 탭 정보 가져오기
                for (let i = 0; i < comp.getTabCount(); i++) {
                    const methods = Object.keys(comp).filter(k => typeof comp[k] === 'function' && k.toLowerCase().includes('tab'));
                    if (i === 0) results.push(`    tab methods: ${methods.join(', ')}`);

                    // 탭 헤더 요소에서 텍스트 가져오기
                    try {
                        const tabEl = document.querySelector(`#${tid}_tablist_${i}`) ||
                                     document.querySelector(`#${tid} [role="tab"]:nth-child(${i + 1})`);
                        if (tabEl) {
                            results.push(`    tab[${i}] text: "${tabEl.textContent?.trim().slice(0, 30)}"`);
                        }
                    } catch { /* ignore */ }
                }

                // 송달/문건 탭 인덱스 찾기 시도
                const tabHeaders = document.querySelectorAll(`#${tid} [role="tab"]`);
                tabHeaders.forEach((th, idx) => {
                    const text = th.textContent?.trim() || '';
                    results.push(`    header[${idx}] text="${text.slice(0, 30)}"`);
                    if (text.includes('송달') || text.includes('문건')) {
                        results.push(`    → 송달/문건 탭 발견! index=${idx}`);
                        // 탭 전환 시도
                        try {
                            comp.setSelectedTabIndex(idx);
                            results.push(`    → setSelectedTabIndex(${idx}) 호출 완료`);
                        } catch (e) {
                            results.push(`    → setSelectedTabIndex 에러: ${String(e).slice(0, 100)}`);
                        }
                    }
                });
            }
        }

        return results;
    }).catch(e => [`ws tab evaluate error: ${String(e).slice(0, 200)}`]);

    wsTabResult.forEach(line => console.log(`    ${line}`));
    await page.waitForTimeout(3000); // 탭 전환 후 API 응답 대기

    // ========================================
    // 테스트 5: 직접 fetch (비교용)
    // ========================================
    console.log('\n=== 5. 직접 fetch 비교 ===');
    const directResult = await page.evaluate(
        async (params: { cortOfcCd: string; csNo: string }) => {
            const res = await fetch('/pgj/pgj15A/selectDlvrOfdocDtsDtl.on', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    dma_srchDlvrOfdocDts: {
                        cortOfcCd: params.cortOfcCd,
                        csNo: params.csNo,
                    },
                }),
            });
            return { status: res.status, body: (await res.text()).slice(0, 300) };
        },
        { cortOfcCd: target.cortOfcCd, csNo: target.csNo },
    );
    console.log(`  HTTP ${directResult.status}: ${directResult.body}`);

    // ========================================
    // 테스트 6: WebSquare의 데이터 제출 방식 캡처 (XMLHttpRequest 모니터링)
    // ========================================
    console.log('\n=== 6. XMLHttpRequest/fetch 모니터링 설정 후 탭 재클릭 ===');

    // XHR/fetch 패치하여 WebSquare가 보내는 요청 캡처
    await targetFrame.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        w.__capturedXHR = [];

        // XMLHttpRequest 패치
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method: string, url: string) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any).__url = url;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any).__method = method;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any).__headers = {};
            return origOpen.apply(this, arguments as any);
        };
        const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (!(this as any).__headers) (this as any).__headers = {};
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (this as any).__headers[name] = value;
            return origSetHeader.apply(this, arguments as any);
        };
        XMLHttpRequest.prototype.send = function (body?: string | null) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const self = this as any;
            if (self.__url?.includes('.on')) {
                w.__capturedXHR.push({
                    url: self.__url,
                    method: self.__method,
                    headers: self.__headers,
                    body: typeof body === 'string' ? body.slice(0, 500) : String(body),
                    timestamp: Date.now(),
                });
                console.log(`[XHR CAPTURE] ${self.__method} ${self.__url}`);
            }
            return origSend.apply(this, arguments as any);
        };
    });

    // 다시 탭 클릭 시도
    console.log('  XHR 모니터링 설정 완료. 송달 탭 재클릭 시도...');
    try {
        const deliveryTab = targetFrame.locator(':text("송달")').first();
        const isVisible = await deliveryTab.isVisible({ timeout: 2000 }).catch(() => false);
        if (isVisible) {
            await deliveryTab.click({ timeout: 5000 });
            await page.waitForTimeout(3000);
        }
    } catch { /* ignore */ }

    // XHR 캡처 결과 확인
    const xhrCaptures = await targetFrame.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (window as any).__capturedXHR || [];
    });
    console.log(`  캡처된 XHR: ${xhrCaptures.length}개`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    xhrCaptures.forEach((xhr: any, i: number) => {
        console.log(`  XHR[${i}] ${xhr.method} ${xhr.url}`);
        console.log(`    headers: ${JSON.stringify(xhr.headers).slice(0, 200)}`);
        console.log(`    body: ${xhr.body}`);
    });

    // ========================================
    // 요약
    // ========================================
    console.log('\n=== 요약 ===');
    const dlvrResponses = capturedResponses.filter(r =>
        r.url.includes('Dlvr') || r.url.includes('dlvr') || r.url.includes('Ofdoc')
    );
    console.log(`  총 캡처된 요청: ${capturedRequests.length}개`);
    console.log(`  총 캡처된 응답: ${capturedResponses.length}개`);
    console.log(`  송달/문건 관련 응답: ${dlvrResponses.length}개`);
    dlvrResponses.forEach(r => {
        console.log(`    ${r.url} → HTTP ${r.status}`);
        console.log(`    body: ${r.body.slice(0, 300)}`);
    });
    console.log(`  직접 fetch 결과: HTTP ${directResult.status}`);

    // 헤더 비교
    const wsRequests = capturedRequests.filter(r =>
        r.url.includes('Dlvr') || r.url.includes('dlvr') || r.url.includes('Ofdoc')
    );
    if (wsRequests.length > 0) {
        console.log('\n  === WebSquare 요청 vs 직접 fetch 헤더 비교 ===');
        const wsReq = wsRequests[0];
        console.log(`  WebSquare 요청 헤더:`);
        Object.entries(wsReq.headers).forEach(([k, v]) => {
            console.log(`    ${k}: ${v.slice(0, 100)}`);
        });
    }

    console.log('\n=== 진단 v2 완료 ===');
    await browser.close();
}

main().catch(console.error);
