import { randomUUID } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { authJson } from './_shared/auth/http.mjs';
import { createAuthRuntime, requireRequestCapability, assertBrowserWriteRequest, authErrorResponse } from './_shared/auth/runtime.mjs';

const ID = /^[a-z0-9-]{1,64}$/;
const MAX_IMAGE = 3 * 1024 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { status, publicMessage: message });
export function imageType(bytes) {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0,8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (Buffer.from(bytes.subarray(0,4)).toString() === 'RIFF' && Buffer.from(bytes.subarray(8,12)).toString() === 'WEBP') return 'image/webp';
  throw fail('Only PNG, JPEG and WebP images are supported');
}
function metadata(body) {
  const title = String(body.title || '').trim();
  const titleEn = String(body.titleEn || '').trim();
  if (!title || title.length > 160 || titleEn.length > 160) throw fail('Title is required (maximum 160 characters)');
  if (!['weekly','public','vip'].includes(body.category)) throw fail('Invalid category');
  return { title, titleEn, category: body.category };
}
export function createGuidesHandler(overrides = {}) {
  // Instantiate auth lazily: public catalogs do not depend on auth/database availability.
  const authorize = (request, capability) => requireRequestCapability(createAuthRuntime(overrides), request, capability);
  return async request => {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    const asset = url.searchParams.get('asset');
    const admin = url.searchParams.get('admin') === '1';
    try {
      if (!['GET','POST'].includes(request.method)) return authJson({error:'Method not allowed'}, {status:405,headers:{Allow:'GET, POST'}});
      if ((id && !ID.test(id)) || (asset && !ID.test(asset))) throw fail('Invalid identifier');
      if (request.method === 'POST') {
        assertBrowserWriteRequest(request, overrides);
        await authorize(request, 'isAdmin');
      } else if (admin) await authorize(request, 'isAdmin');
      const store = overrides.store || getStore({name:'guide-library', consistency:'strong'});
      if (request.method === 'GET') {
        if (!id) {
          if (asset) throw fail('Guide ID required');
          const rows = [];
          for await (const page of store.list({prefix:'guides/', paginate:true})) {
            for (const blob of page.blobs) {
              const guide = await store.get(blob.key, {type:'json'});
              if (guide && (admin || guide.status === 'published')) {
                const {pages, pagesEn = [], ...summary} = guide;
                rows.push({...summary, pageCount: pages.length, pageCountEn: pagesEn.length});
              }
            }
          }
          rows.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
          return authJson({guides:rows});
        }
        const guide = await store.get(`guides/${id}`, {type:'json'});
        if (!guide || (!admin && guide.status !== 'published')) throw fail('Guide not found',404);
        if (guide.category === 'vip' && !admin) await authorize(request, 'canAccessPremium');
        if (!asset) return authJson({guide});
        if (![...guide.pages, ...(guide.pagesEn || [])].includes(asset)) throw fail('Page not found',404);
        const result = await store.getWithMetadata(`assets/${id}/${asset}`, {type:'arrayBuffer'});
        if (!result) throw fail('Page not found',404);
        return new Response(result.data, {headers:{'Content-Type':result.metadata.contentType, 'Cache-Control':'private, no-store', 'Netlify-CDN-Cache-Control':'no-store', 'Vary':'Cookie', 'X-Content-Type-Options':'nosniff', 'Content-Security-Policy':"default-src 'none'", 'Content-Disposition':'inline'}});
      }
      // Keep each upload below the serverless binary request limit. Originals are not recompressed.
      if (url.searchParams.get('upload') === '1') {
        if (!id) throw fail('Guide ID required');
        const guide = await store.get(`guides/${id}`, {type:'json'});
        if (!guide) throw fail('Guide not found',404);
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (!bytes.length || bytes.length > MAX_IMAGE) throw fail('Each image must be 3 MB or smaller');
        const contentType = imageType(bytes);
        const assetId = randomUUID();
        await store.set(`assets/${id}/${assetId}`, bytes, {metadata:{contentType}});
        return authJson({asset:assetId});
      }
      const body = await request.json().catch(() => {throw fail('Invalid JSON');});
      if (body.action === 'create') {
        const guide = {...metadata(body), id:randomUUID(), status:'draft', pages:[], pagesEn:[], revision:0, updatedAt:new Date().toISOString()};
        await store.setJSON(`guides/${guide.id}`, guide);
        return authJson({guide});
      }
      if (!id) throw fail('Guide ID required');
      const stored = await store.getWithMetadata(`guides/${id}`, {type:'json'});
      if (!stored) throw fail('Guide not found',404);
      const guide = stored.data;
      if (body.action === 'edit' && body.revision !== (guide.revision || 0)) throw fail('Guide changed; reload before saving',409);
      if (body.action === 'publish' || body.action === 'edit') {
        if (body.action === 'publish' && guide.status !== 'draft') throw fail('Only drafts may be published',409);
        if (body.action === 'edit') Object.assign(guide, metadata(body));
        const pagesEn = body.pagesEn ?? guide.pagesEn ?? [];
        if (![body.pages, pagesEn].every(pages => Array.isArray(pages) && pages.length <= 100 && new Set(pages).size === pages.length) || body.pages.length + pagesEn.length === 0) throw fail('Provide 1–100 unique pages per language');
        for (const page of [...body.pages, ...pagesEn]) {
          if (typeof page !== 'string' || !ID.test(page) || !await store.getMetadata(`assets/${id}/${page}`)) throw fail('An uploaded page is missing');
        }
        guide.pages = body.pages;
        guide.pagesEn = pagesEn;
        guide.publishedAt = guide.status === 'published' ? (guide.publishedAt || guide.updatedAt) : new Date().toISOString();
        guide.status = 'published';
      } else if (body.action === 'unpublish') {
        guide.status = 'draft';
      } else throw fail('Invalid action');
      guide.updatedAt = new Date().toISOString();
      guide.revision = (guide.revision || 0) + 1;
      const result = await store.setJSON(`guides/${id}`, guide, {onlyIfMatch:stored.etag});
      if (result?.modified === false) throw fail('Guide changed; reload before saving',409);
      return authJson({guide});
    } catch (error) {
      if (error.publicMessage) return authJson({error:error.publicMessage}, {status:error.status});
      return authErrorResponse(error, authJson, 503);
    }
  };
}
export default request => createGuidesHandler()(request);
export const config = {path:'/api/guides'};
