import type { HtmlAsset } from '../shared/ipc.ts'

// HTML 미리보기 문서 (이슈 #29) — dsh ui-sidebar-documentpreview html/bootstrap·pack 참조(방식만, 코드는 새로 씀).
// 격리: iframe 은 sandbox="allow-scripts" 만(same-origin 없음 → 불투명 출처라 앱 화면·preload(window.litecode)·쿠키·저장소에 못 닿는다),
// 문서는 파일 경로(file://)가 아니라 메인이 준 글을 srcdoc 으로. iframe 은 파일을 못 읽으므로 같은 폴더 스크립트·스타일은 메인이 읽어 준
// 글을 iframe 안에서 blob: 주소로 만들어 바꿔 끼우고(부모가 만든 blob: 은 불투명 출처가 못 읽는다 — dsh 와 같은 이유), 이미지는 data: 주소.
// 외부 요청: CSP 로 fetch·XHR·WebSocket·외부 스크립트/스타일/이미지/글꼴·하위 iframe·폼 전송을 막는다(인라인 스크립트·스타일은 허용 —
// 테트리스 같은 한 파일짜리가 돌아야 한다). CSP 로 못 막는 이동(링크·location·meta refresh)은 메인의 will-frame-navigate 가 막고,
// 팝업·top 이동은 sandbox 가 막는다. dsh 와 다른 점: dsh 는 https 리소스를 브라우저에 맡기지만 여기선 폐쇄망 앱이라 외부 요청 0.

/** 부트스트랩 문서와 그것이 쓰는 원래 문서 둘 다에 넣는다 — 여러 정책은 모두 적용되므로 문서가 지우거나 덧붙여도 더 풀리지 않는다 */
export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline' blob:",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/** 문서가 직접 적은 같은 폴더 리소스 — 고전 스크립트 src, 스타일시트 link href, img src. 부모 화면에서 DOMParser 로 읽는다(실행·로드 없음) */
export function collectReferences(html: string): string[] {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const found = new Set<string>()
  for (const script of parsed.querySelectorAll('script[src]')) {
    const type = script.getAttribute('type')?.trim().toLowerCase() ?? ''
    if (['', 'text/javascript', 'application/javascript'].includes(type)) found.add(script.getAttribute('src')!)
  }
  for (const link of parsed.querySelectorAll('link[href]')) {
    if ((link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet')) found.add(link.getAttribute('href')!)
  }
  for (const image of parsed.querySelectorAll('img[src]')) found.add(image.getAttribute('src')!)
  return [...found].filter((reference) => reference && !/^(?:[a-z][a-z\d+.-]*:|[/\\#?])/i.test(reference))
}

/** iframe srcdoc — CSP 를 맨 앞에 둔 부트스트랩이 원래 문서에 리소스를 끼워 그 자리에 다시 쓴다(document.write) */
export function buildHtmlDocument(html: string, assets: readonly HtmlAsset[]): string {
  const payload = toBase64(JSON.stringify({ html, assets, policy: HTML_PREVIEW_CSP }))
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"><script>(()=>{
const bundle=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob("${payload}"),c=>c.charCodeAt(0))));
const doc=new DOMParser().parseFromString(bundle.html,'text/html');
const policy=doc.createElement('meta');policy.httpEquiv='Content-Security-Policy';policy.content=bundle.policy;doc.head.prepend(policy);
const blob=(text,type)=>URL.createObjectURL(new Blob([text],{type}));
for(const asset of bundle.assets){
  if('dataUrl' in asset){for(const el of doc.querySelectorAll('img[src]'))if(el.getAttribute('src')===asset.reference)el.setAttribute('src',asset.dataUrl);continue}
  let js,css;
  for(const el of doc.querySelectorAll('script[src]'))if(el.getAttribute('src')===asset.reference)el.setAttribute('src',js??=blob(asset.text,'text/javascript'));
  for(const el of doc.querySelectorAll('link[href]'))if(el.getAttribute('href')===asset.reference&&/(^|\\s)stylesheet(\\s|$)/i.test(el.getAttribute('rel')||''))el.setAttribute('href',css??=blob(asset.text,'text/css'));
}
document.open();document.write('<!doctype html>'+doc.documentElement.outerHTML);document.close();
})()</script>`
}

/** UTF-8 글의 base64 — 부트스트랩 스크립트 안에 넣을 때 `</script>`·따옴표가 문제 되지 않게 */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}
