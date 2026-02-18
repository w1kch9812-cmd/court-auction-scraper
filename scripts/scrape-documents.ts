#!/usr/bin/env npx tsx
/**
 * 법원경매 송달/문건내역 수집
 *
 * API: selectDlvrOfdocDtsDtl.on
 * 수집: 송달내역(dlt_dlvrDtsLst), 문건내역(dlt_ofdocDtsLst), 병합기록, 선행사건
 *
 * Usage:
 *   npx tsx scripts/scrape-documents.ts              # 전체 수집
 *   npx tsx scripts/scrape-documents.ts --test        # 테스트 (5건)
 *   npx tsx scripts/scrape-documents.ts --resume      # 이어받기
 */

import { chromium, type Page } from 'playwright';
import fs from 'fs';
import path from 'path';

// ======= CLI 옵션 =======
const TEST_MODE = process.argv.includes('--test');
const RESUME = process.argv.includes('--resume');

// ======= 설정 =======
const SEARCH_PAGE = 'https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml';
const DELAY_BETWEEN = 1500;
const BATCH_REST_INTERVAL = 50;
const BATCH_REST_DURATION = 15000;
const IP_BLOCK_WAIT = 3 * 60 * 1000;
const MAX_CONSECUTIVE_BLOCKS = 5;

const DATA_DIR = path.join(process.cwd(), 'data');
const DETAILS_FILE = path.join(DATA_DIR, 'court-auction-details.json');
const PROGRESS_FILE = path.join(process.cwd(), 'temp', 'progress.json');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface DetailEntry {
    cortOfcCd: string;
    csNo: string;
    courtName: string;
    caseNumber: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
}

interface ProgressData {
    completed: string[];
    total: number;
    startedAt: string;
    lastUpdated: string;
}

// ======= 송달/문건내역 API =======
async function scrapeDocuments(
    page: Page,
    cortOfcCd: string,
    csNo: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Record<string, any> | null> {
    return page.evaluate(
        async (params: { cortOfcCd: string; csNo: string }) => {
            try {
                const res = await fetch('/pgj/pgj15A/selectDlvrOfdocDtsDtl.on', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cortOfcCd: params.cortOfcCd, csNo: params.csNo }),
                });
                const text = await res.text();
                let json;
                try { json = JSON.parse(text); } catch { return { __error: true, status: res.status, body: text.slice(0, 200) }; }
                // 새 API 래퍼 형식 대응
                const data = json.data || json;
                if (json.message?.includes('차단') || data?.ipcheck === false) {
                    return { __blocked: true, message: json.message };
                }
                // 550 = 데이터 없음 (정상 응답)
                if (res.status === 550) {
                    return { __nodata: true, message: json.message || '데이터 없음' };
                }
                if (!res.ok) return { __error: true, status: res.status, message: json.message };
                return data;
            } catch (e) {
                return { __error: true, message: String(e) };
            }
        },
        { cortOfcCd, csNo },
    );
}

// ======= 진행상황 관리 =======
function loadProgress(): ProgressData {
    if (RESUME && fs.existsSync(PROGRESS_FILE)) {
        return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    }
    return {
        completed: [],
        total: 0,
        startedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
    };
}

function saveProgress(progress: ProgressData) {
    progress.lastUpdated = new Date().toISOString();
    const dir = path.dirname(PROGRESS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ======= 메인 =======
async function main() {
    console.log('=== 법원경매 송달/문건내역 수집 ===');
    console.log(`옵션: 테스트=${TEST_MODE}, 이어받기=${RESUME}\n`);

    if (!fs.existsSync(DETAILS_FILE)) {
        console.error('court-auction-details.json이 없습니다: ' + DETAILS_FILE);
        process.exit(1);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawData: Record<string, any> = JSON.parse(fs.readFileSync(DETAILS_FILE, 'utf-8'));
    const details: DetailEntry[] = Array.isArray(rawData)
        ? rawData
        : Object.values(rawData);
    console.log(`기존 상세 데이터: ${details.length}건`);

    // 진행상황
    const progress = loadProgress();
    const completedSet = new Set(progress.completed);

    // 수집 대상: deliveryRecords 필드가 없는 건만
    let targets = details.filter((d) => {
        const key = d.cortOfcCd + d.csNo;
        if (completedSet.has(key)) return false;
        if (d.deliveryRecords !== undefined) return false; // 이미 수집됨
        return true;
    });

    if (TEST_MODE) {
        // 테스트: 현황조사 있는 건(진행된 사건) 우선 + 초기 사건 섞어서
        const advanced = targets.filter(d => d.investigation?.dma_curstExmnMngInf && Object.keys(d.investigation.dma_curstExmnMngInf).length > 0);
        const early = targets.filter(d => !d.investigation?.dma_curstExmnMngInf || Object.keys(d.investigation.dma_curstExmnMngInf).length === 0);
        targets = [...advanced.slice(0, 3), ...early.slice(0, 2)];
        console.log(`테스트: 진행건 ${Math.min(3, advanced.length)}개 + 초기건 ${Math.min(2, early.length)}개`);
    }

    console.log(`수집 대상: ${targets.length}건 (완료: ${completedSet.size}건)\n`);

    if (targets.length === 0) {
        console.log('모든 건 수집 완료!');
        return;
    }

    progress.total = details.length;

    // 결과 맵
    const detailMap = new Map<string, DetailEntry>();
    for (const d of details) {
        detailMap.set(d.cortOfcCd + d.csNo, d);
    }

    // 저장 함수
    const saveDetails = () => {
        if (Array.isArray(rawData)) {
            fs.writeFileSync(DETAILS_FILE, JSON.stringify(details, null, 2));
        } else {
            const out: Record<string, DetailEntry> = {};
            for (let idx = 0; idx < details.length; idx++) {
                out[String(idx)] = details[idx];
            }
            fs.writeFileSync(DETAILS_FILE, JSON.stringify(out, null, 2));
        }
    };

    // 브라우저 시작
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        locale: 'ko-KR',
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
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

    // 통계
    let success = 0;
    let errors = 0;
    let consecutiveBlocks = 0;
    const stats = { deliveryItems: 0, documentItems: 0 };

    for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const key = t.cortOfcCd + t.csNo;

        // 배치 휴식
        if (i > 0 && i % BATCH_REST_INTERVAL === 0) {
            console.log(`  [휴식] ${BATCH_REST_DURATION / 1000}초 (${i}/${targets.length})`);
            await page.waitForTimeout(BATCH_REST_DURATION);
        }

        process.stdout.write(`[${i + 1}/${targets.length}] ${t.caseNumber} (${t.courtName}) `);

        const entry = detailMap.get(key);
        if (!entry) {
            console.log('- 매핑 실패');
            errors++;
            progress.completed.push(key);
            continue;
        }

        try {
            const result = await scrapeDocuments(page, t.cortOfcCd, t.csNo);

            if (result?.__blocked) {
                consecutiveBlocks++;
                console.log(`- 차단! (${consecutiveBlocks}/${MAX_CONSECUTIVE_BLOCKS})`);

                if (consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) {
                    console.log('\n연속 차단 한계 도달. 저장 후 종료.');
                    saveDetails();
                    saveProgress(progress);
                    await browser.close();
                    process.exit(1);
                }

                console.log(`  ${IP_BLOCK_WAIT / 1000}초 대기...`);
                await page.waitForTimeout(IP_BLOCK_WAIT);
                await page.goto(SEARCH_PAGE, { waitUntil: 'networkidle', timeout: 60000 });
                await page.waitForTimeout(3000);
                i--;
                continue;
            }

            consecutiveBlocks = 0;

            if (result?.__nodata) {
                entry.deliveryRecords = [];
                entry.documentRecords = [];
                console.log(`- 데이터없음 (${result.message})`);
            } else if (result && !result.__error) {
                const deliveryList = result.dlt_dlvrDtsLst || [];
                const documentList = result.dlt_ofdocDtsLst || [];
                const mergerList = result.dlt_mrgDpcnSbxLst || [];
                const priorCase = result.dma_trnscsBfCsInfo || null;

                entry.deliveryRecords = deliveryList;
                entry.documentRecords = documentList;
                if (mergerList.length > 0) entry.mergerRecords = mergerList;
                if (priorCase && Object.keys(priorCase).length > 0) entry.priorCaseInfo = priorCase;

                stats.deliveryItems += deliveryList.length;
                stats.documentItems += documentList.length;
                console.log(`- 송달${deliveryList.length} 문건${documentList.length}`);
            } else {
                entry.deliveryRecords = [];
                entry.documentRecords = [];
                console.log(`- 에러: ${result?.__error ? (result.message || result.status) : 'unknown'}`);
                errors++;
            }

            success++;
            progress.completed.push(key);

            // 10건마다 저장
            if (i % 10 === 0 || TEST_MODE) {
                saveProgress(progress);
                saveDetails();
            }
        } catch (e) {
            errors++;
            console.log(`- 에러: ${String(e).slice(0, 80)}`);
        }

        await page.waitForTimeout(DELAY_BETWEEN);
    }

    // 최종 저장
    console.log('\n최종 저장...');
    saveDetails();
    saveProgress(progress);

    console.log(`\n=== 완료 ===`);
    console.log(`  성공: ${success}건`);
    console.log(`  실패: ${errors}건`);
    console.log(`  송달내역: ${stats.deliveryItems}건`);
    console.log(`  문건내역: ${stats.documentItems}건`);

    await browser.close();
}

main().catch(console.error);
