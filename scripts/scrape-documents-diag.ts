#!/usr/bin/env npx tsx
/**
 * 법원경매 송달/문건내역 API 진단 스크립트
 *
 * 목적: selectDlvrOfdocDtsDtl.on API의 올바른 호출 방식을 찾기
 *
 * 테스트 순서:
 * 1. WebSquare setSrc로 사건 상세 페이지 열기 (서버 세션 확립)
 * 2. 다양한 body 형식으로 송달/문건 API 시도
 * 3. 네트워크 트래픽 캡처하여 실제 요청 형식 확인
 */

import { chromium, type Page } from 'playwright';
import fs from 'fs';
import path from 'path';

const SEARCH_PAGE = 'https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml';
const DETAILS_FILE = path.join(process.cwd(), 'data', 'court-auction-details.json');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface DetailEntry { cortOfcCd: string; csNo: string; courtName: string; caseNumber: string; [key: string]: any; }

// ======= 네트워크 응답 대기 =======
async function waitForApiResponse(
    page: Page,
    urlPattern: string,
    timeout = 15000,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Record<string, any> | null> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            page.removeListener('response', handler);
            resolve(null);
        }, timeout);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handler = async (response: any) => {
            const url = response.url();
            if (url.includes(urlPattern)) {
                clearTimeout(timer);
                page.removeListener('response', handler);
                try {
                    const status = response.status();
                    const body = await response.text();
                    console.log(`    [CAPTURE] ${urlPattern} → HTTP ${status}, ${body.length}bytes`);
                    if (body.length < 500) console.log(`    [BODY] ${body.slice(0, 300)}`);
                    const json = JSON.parse(body);
                    resolve({ __status: status, ...(json.data || json) });
                } catch {
                    resolve(null);
                }
            }
        };
        page.on('response', handler);
    });
}

// ======= WebSquare로 사건 상세 열기 =======
async function openCaseDetailViaSrc(page: Page, cortOfcCd: string, csNo: string) {
    const responsePromise = waitForApiResponse(page, 'selectAuctnCsSrchRslt.on', 15000);

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
    }, { csNo, cortOfcCd });

    return await responsePromise;
}

// ======= 다양한 body 형식으로 송달/문건 API 시도 =======
async function tryDocumentsApi(
    page: Page,
    cortOfcCd: string,
    csNo: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<void> {
    // 형식 1: 기존 (bare)
    console.log('  [형식1] { cortOfcCd, csNo } (bare)');
    const r1 = await page.evaluate(
        async (params: { cortOfcCd: string; csNo: string }) => {
            const res = await fetch('/pgj/pgj15A/selectDlvrOfdocDtsDtl.on', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cortOfcCd: params.cortOfcCd, csNo: params.csNo }),
            });
            const text = await res.text();
            return { status: res.status, body: text.slice(0, 500) };
        },
        { cortOfcCd, csNo },
    );
    console.log(`    → HTTP ${r1.status}: ${r1.body.slice(0, 200)}`);

    // 형식 2: dma_ 래퍼 (추측1)
    console.log('  [형식2] { dma_srchDlvrOfdocDts: { cortOfcCd, csNo } }');
    const r2 = await page.evaluate(
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
            const text = await res.text();
            return { status: res.status, body: text.slice(0, 500) };
        },
        { cortOfcCd, csNo },
    );
    console.log(`    → HTTP ${r2.status}: ${r2.body.slice(0, 200)}`);

    // 형식 3: dma_ 래퍼 (추측2 - Dtl 포함)
    console.log('  [형식3] { dma_srchDlvrOfdocDtsDtl: { cortOfcCd, csNo } }');
    const r3 = await page.evaluate(
        async (params: { cortOfcCd: string; csNo: string }) => {
            const res = await fetch('/pgj/pgj15A/selectDlvrOfdocDtsDtl.on', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    dma_srchDlvrOfdocDtsDtl: {
                        cortOfcCd: params.cortOfcCd,
                        csNo: params.csNo,
                    },
                }),
            });
            const text = await res.text();
            return { status: res.status, body: text.slice(0, 500) };
        },
        { cortOfcCd, csNo },
    );
    console.log(`    → HTTP ${r3.status}: ${r3.body.slice(0, 200)}`);

    // 형식 4: 빈 객체
    console.log('  [형식4] {} (empty)');
    const r4 = await page.evaluate(
        async () => {
            const res = await fetch('/pgj/pgj15A/selectDlvrOfdocDtsDtl.on', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const text = await res.text();
            return { status: res.status, body: text.slice(0, 500) };
        },
    );
    console.log(`    → HTTP ${r4.status}: ${r4.body.slice(0, 200)}`);

    // 형식 5: dma_ 래퍼 + dspslGdsSeq
    console.log('  [형식5] { cortOfcCd, csNo, dspslGdsSeq: "1" }');
    const r5 = await page.evaluate(
        async (params: { cortOfcCd: string; csNo: string }) => {
            const res = await fetch('/pgj/pgj15A/selectDlvrOfdocDtsDtl.on', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cortOfcCd: params.cortOfcCd,
                    csNo: params.csNo,
                    dspslGdsSeq: '1',
                }),
            });
            const text = await res.text();
            return { status: res.status, body: text.slice(0, 500) };
        },
        { cortOfcCd, csNo },
    );
    console.log(`    → HTTP ${r5.status}: ${r5.body.slice(0, 200)}`);
}

// ======= 네트워크 스니핑: setSrc 후 모든 API 트래픽 캡처 =======
async function captureAllTraffic(page: Page, cortOfcCd: string, csNo: string) {
    console.log('\n--- 네트워크 트래픽 캡처 시작 ---');
    const captured: { url: string; status: number; bodyPreview: string; requestBody?: string }[] = [];

    // 모든 요청/응답 캡처
    page.on('request', (req) => {
        const url = req.url();
        if (url.includes('.on') && req.method() === 'POST') {
            const postData = req.postData();
            console.log(`  [REQ] POST ${url.split('/pgj/')[1] || url}`);
            if (postData) console.log(`    body: ${postData.slice(0, 200)}`);
        }
    });

    page.on('response', async (res) => {
        const url = res.url();
        if (url.includes('.on')) {
            try {
                const text = await res.text();
                console.log(`  [RES] ${url.split('/pgj/')[1] || url} → ${res.status()} (${text.length}b)`);
                captured.push({
                    url: url.split('/pgj/')[1] || url,
                    status: res.status(),
                    bodyPreview: text.slice(0, 100),
                });
            } catch { /* ignore */ }
        }
    });

    // 사건 상세 페이지를 WebSquare setSrc로 열기
    console.log(`\n  WebSquare setSrc → PGJ15AF01.xml (${cortOfcCd}/${csNo})`);
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
    }, { csNo, cortOfcCd });

    // 모든 로딩 대기
    await page.waitForTimeout(5000);

    console.log(`\n--- 캡처된 응답: ${captured.length}개 ---`);
    return captured;
}

// ======= 메인 =======
async function main() {
    console.log('=== 법원경매 송달/문건 API 진단 ===\n');

    if (!fs.existsSync(DETAILS_FILE)) {
        console.error('court-auction-details.json이 없습니다: ' + DETAILS_FILE);
        process.exit(1);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawData: Record<string, any> = JSON.parse(fs.readFileSync(DETAILS_FILE, 'utf-8'));
    const details: DetailEntry[] = Array.isArray(rawData) ? rawData : Object.values(rawData);

    // 진행된 사건 선택 (investigation 있는 건)
    const advanced = details.filter(d =>
        d.investigation?.dma_curstExmnMngInf && Object.keys(d.investigation.dma_curstExmnMngInf).length > 0
    );
    const target = advanced[0];
    if (!target) {
        console.error('테스트할 사건 없음');
        process.exit(1);
    }

    console.log(`테스트 대상: ${target.caseNumber} (${target.courtName})`);
    console.log(`  cortOfcCd=${target.cortOfcCd}, csNo=${target.csNo}\n`);

    // 브라우저 시작
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

    if (!wsReady) {
        console.error('WebSquare 초기화 실패');
        await browser.close();
        process.exit(1);
    }
    console.log('세션 확보 완료\n');

    // === 테스트 1: API 직접 호출 (서버 상태 없이) ===
    console.log('=== 테스트 1: 서버 상태 없이 직접 API 호출 ===');
    await tryDocumentsApi(page, target.cortOfcCd, target.csNo);

    // === 테스트 2: 네트워크 트래픽 캡처 ===
    await captureAllTraffic(page, target.cortOfcCd, target.csNo);

    // === 테스트 3: WebSquare 사건 상세 열기 후 API 호출 ===
    console.log('\n=== 테스트 3: setSrc 후 API 재시도 ===');
    await tryDocumentsApi(page, target.cortOfcCd, target.csNo);

    // === 테스트 4: 두번째 사건 (다른 사건으로 테스트) ===
    if (advanced.length > 1) {
        const target2 = advanced[1];
        console.log(`\n=== 테스트 4: 두번째 사건 ${target2.caseNumber} ===`);

        // setSrc로 두번째 사건 열기
        const caseResult = await openCaseDetailViaSrc(page, target2.cortOfcCd, target2.csNo);
        console.log(`  사건상세 결과: ${caseResult ? 'OK' : 'FAIL'}`);
        await page.waitForTimeout(1000);

        // 다시 송달/문건 시도
        await tryDocumentsApi(page, target2.cortOfcCd, target2.csNo);
    }

    console.log('\n=== 진단 완료 ===');
    await browser.close();
}

main().catch(console.error);
