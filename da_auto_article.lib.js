// ==UserScript==
// @name         iOffice & Portal Lam Dong - Tự động tạo bài viết từ tài liệu PDF/Word
// @namespace    http://tampermonkey.net/
// @version      3.2
// @description  Hỗ trợ chọn nhiều file, tự động tải lên máy chủ Media Lâm Đồng, tạo thư mục ngày DD-MM-YYYY, lấy link thật gán CKEditor và Avatar, phân tích Gemini 3.7 Flash.
// @author       DA Assistant
// @match        https://*.lamdong.gov.vn/admin/*
// @match        https://ducan.lamdong.gov.vn/admin/*
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      generativelanguage.googleapis.com
// @connect      *
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
// ==/UserScript==

(function () {
    'use strict';

    const pageWin = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);

    // ==========================================
    // 0. BỘ BẮT VÀ ĐỒNG BỘ HEADERS & PAYLOAD XÁC THỰC TỰ ĐỘNG
    // ==========================================
    let currentUploadedAvatarUrl = '';
    let currentEditorContentHtml = '';
    let currentArticleTitleText = '';
    let currentArticleTypeId = '';
    let currentArticleTypeName = '';
    let currentPublishDateStr = '';
    let isDateManuallyEditedByUser = false;

    const liveCmsHeaders = {
        'unitcode': 'LDG',
        'deviceid': 'Web;Chrome;cd3a6920-b9fc-4380-9f62-98b07f462b00',
        'currentpublicip': '104.28.217.54'
    };

    // Hook XMLHttpRequest & Fetch trên cả Page Context (unsafeWindow) và Sandbox Window
    const winContexts = [window];
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow !== window) {
        winContexts.push(unsafeWindow);
    }

    winContexts.forEach(w => {
        // 0.0. Bảo vệ chống lỗi race-condition getComputedStyle của CKEditor 4 khi Form mở trong Angular
        try {
            const patchCk = (ck) => {
                if (!ck || !ck.dom || !ck.dom.element || !ck.dom.element.prototype) return;
                if (ck.dom.element.prototype._daPatched) return;
                ck.dom.element.prototype._daPatched = true;

                const origGetComputedStyle = ck.dom.element.prototype.getComputedStyle;
                if (origGetComputedStyle) {
                    ck.dom.element.prototype.getComputedStyle = function (propertyName) {
                        try {
                            const win = this.getWindow();
                            if (win && win.$ && win.$.getComputedStyle) {
                                return origGetComputedStyle.apply(this, arguments);
                            }
                        } catch (e) {}
                        return '';
                    };
                }

                const origGetDirection = ck.dom.element.prototype.getDirection;
                if (origGetDirection) {
                    ck.dom.element.prototype.getDirection = function () {
                        try {
                            return origGetDirection.apply(this, arguments);
                        } catch (e) {
                            return 'ltr';
                        }
                    };
                }
            };

            if (w.CKEDITOR) {
                patchCk(w.CKEDITOR);
            }

            let currentCK = w.CKEDITOR;
            try {
                Object.defineProperty(w, 'CKEDITOR', {
                    configurable: true,
                    enumerable: true,
                    get: () => currentCK,
                    set: (val) => {
                        currentCK = val;
                        try { patchCk(val); } catch (e) {}
                    }
                });
            } catch (e) {}
        } catch (e) {}

        try {
            const origOpen = w.XMLHttpRequest.prototype.open;
            w.XMLHttpRequest.prototype.open = function (method, url) {
                this._daReqUrl = url;
                return origOpen.apply(this, arguments);
            };

            const origSetRequestHeader = w.XMLHttpRequest.prototype.setRequestHeader;
            w.XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
                if (header && value) {
                    const lower = header.toLowerCase();
                    if (['deviceid', 'unitcode', 'currentpublicip', 'authorization', 'token'].includes(lower)) {
                        liveCmsHeaders[header] = value;
                        liveCmsHeaders[lower] = value;
                    }
                }
                return origSetRequestHeader.apply(this, arguments);
            };

            const origSend = w.XMLHttpRequest.prototype.send;
            w.XMLHttpRequest.prototype.send = function (data) {
                try {
                    this.addEventListener('load', function () {
                        if (this._daReqUrl && typeof this._daReqUrl === 'string' && this._daReqUrl.includes('ListLoaiTinTuc') && this.status >= 200 && this.status < 300) {
                            try {
                                const res = JSON.parse(this.responseText);
                                if (res && res.Result && Array.isArray(res.Result) && res.Result.length > 0) {
                                    currentArticleTypeId = res.Result[0].Id;
                                    currentArticleTypeName = res.Result[0].Name;
                                }
                            } catch (e) {}
                        }
                    });
                } catch (e) {}

                if (data && typeof data === 'string') {
                    try {
                        if (data.includes('"Title"') || data.includes('"Content"') || data.includes('"title"') || data.includes('"content"') || data.includes('"ImageUrl"') || data.includes('"imageUrl"') || data.includes('"NewTypeId"') || data.includes('"newTypeId"')) {
                            const parsed = JSON.parse(data);
                            if (parsed && typeof parsed === 'object') {
                                if (currentUploadedAvatarUrl && (!parsed.ImageUrl || parsed.ImageUrl === null || parsed.ImageUrl === '')) {
                                    parsed.ImageUrl = currentUploadedAvatarUrl;
                                }
                                if (currentUploadedAvatarUrl && (!parsed.Avatar || parsed.Avatar === null || parsed.Avatar === '')) {
                                    parsed.Avatar = currentUploadedAvatarUrl;
                                }
                                if (currentUploadedAvatarUrl && (!parsed.Image || parsed.Image === null || parsed.Image === '')) {
                                    parsed.Image = currentUploadedAvatarUrl;
                                }
                                if (currentEditorContentHtml && (!parsed.Content || parsed.Content.trim() === '')) {
                                    parsed.Content = currentEditorContentHtml;
                                }
                                if (currentArticleTitleText && (!parsed.Title || parsed.Title.trim() === '')) {
                                    parsed.Title = currentArticleTitleText;
                                }
                                if (currentArticleTitleText && (!parsed.Alias || parsed.Alias === null || parsed.Alias.trim() === '')) {
                                    parsed.Alias = generateSlug(currentArticleTitleText);
                                }
                                if (currentArticleTypeId && (!parsed.NewTypeId || parsed.NewTypeId === null || parsed.NewTypeId === '')) {
                                    parsed.NewTypeId = currentArticleTypeId;
                                }
                                if (currentPublishDateStr) {
                                    parsed.StrCreateDate = currentPublishDateStr;
                                }
                                if (!parsed.Code || parsed.Code === null || parsed.Code === '') {
                                    const rKey = getCurrentRouteKey();
                                    if (rKey && rKey !== 'default') parsed.Code = rKey;
                                }
                                data = JSON.stringify(parsed);
                            }
                        }
                    } catch (e) {}
                }
                return origSend.call(this, data);
            };

            if (w.fetch) {
                const origFetch = w.fetch;
                w.fetch = async function (resource, init) {
                    const urlStr = typeof resource === 'string' ? resource : (resource && resource.url ? resource.url : '');
                    if (init && init.body && typeof init.body === 'string') {
                        try {
                            if (init.body.includes('"Title"') || init.body.includes('"Content"') || init.body.includes('"title"') || init.body.includes('"content"') || init.body.includes('"NewTypeId"') || init.body.includes('"newTypeId"')) {
                                const parsed = JSON.parse(init.body);
                                if (parsed && typeof parsed === 'object') {
                                    if (currentUploadedAvatarUrl && (!parsed.ImageUrl || parsed.ImageUrl === null || parsed.ImageUrl === '')) {
                                        parsed.ImageUrl = currentUploadedAvatarUrl;
                                    }
                                    if (currentUploadedAvatarUrl && (!parsed.Avatar || parsed.Avatar === null || parsed.Avatar === '')) {
                                        parsed.Avatar = currentUploadedAvatarUrl;
                                    }
                                    if (currentUploadedAvatarUrl && (!parsed.Image || parsed.Image === null || parsed.Image === '')) {
                                        parsed.Image = currentUploadedAvatarUrl;
                                    }
                                    if (currentEditorContentHtml && (!parsed.Content || parsed.Content.trim() === '')) {
                                        parsed.Content = currentEditorContentHtml;
                                    }
                                    if (currentArticleTitleText && (!parsed.Title || parsed.Title.trim() === '')) {
                                        parsed.Title = currentArticleTitleText;
                                    }
                                    if (currentArticleTitleText && (!parsed.Alias || parsed.Alias === null || parsed.Alias.trim() === '')) {
                                        parsed.Alias = generateSlug(currentArticleTitleText);
                                    }
                                    if (currentArticleTypeId && (!parsed.NewTypeId || parsed.NewTypeId === null || parsed.NewTypeId === '')) {
                                        parsed.NewTypeId = currentArticleTypeId;
                                    }
                                    if (currentPublishDateStr) {
                                        parsed.StrCreateDate = currentPublishDateStr;
                                    }
                                    if (!parsed.Code || parsed.Code === null || parsed.Code === '') {
                                        const rKey = getCurrentRouteKey();
                                        if (rKey && rKey !== 'default') parsed.Code = rKey;
                                    }
                                    init.body = JSON.stringify(parsed);
                                }
                            }
                        } catch (e) {}
                    }
                    const response = await origFetch.apply(this, arguments);
                    try {
                        if (urlStr && urlStr.includes('ListLoaiTinTuc') && response.ok) {
                            const clone = response.clone();
                            clone.json().then(res => {
                                if (res && res.Result && Array.isArray(res.Result) && res.Result.length > 0) {
                                    currentArticleTypeId = res.Result[0].Id;
                                    currentArticleTypeName = res.Result[0].Name;
                                }
                            }).catch(() => {});
                        }
                    } catch (e) {}
                    return response;
                };
            }
        } catch (e) {}
    });

    // Cấu hình PDF.js worker
    if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    // ==========================================
    // 1. CÁC PROMPT MẪU THEO URL
    // ==========================================
    const DEFAULT_PROMPTS = {
        // Mẫu cho chuyên mục: Công bố danh mục TTHC
        'cong-bo-danh-muc-tthc': `Bạn là chuyên viên quản trị Cổng thông tin điện tử UBND xã Đức An, tỉnh Lâm Đồng.
Nhiệm vụ: Đọc toàn bộ nội dung văn bản dưới đây (trích xuất từ file: "{filename}") và tạo bài viết cho mục "CÔNG BỐ DANH MỤC TTHC".

Nội dung trích xuất:
"""
{extractedText}
"""

QUY TẮC TIÊU ĐỀ BẮT BUỘC:
Tiêu đề PHẢI theo đúng mẫu:
"Lâm Đồng ban hành [Loại văn bản] số [Số/Ký hiệu] công bố [Trích yếu nội dung danh mục thủ tục hành chính, sửa đổi/bổ sung/bãi bỏ và lĩnh vực liên quan]"
Ví dụ mẫu:
- "Lâm Đồng ban hành Quyết định số 4069/QĐ-UBND công bố Danh mục thủ tục hành chính được sửa đổi, bổ sung, thay thế và bị bãi bỏ lĩnh vực đường thủy nội địa"
- "Lâm Đồng ban hành Quyết định số 4058/QĐ-UBND công bố thủ tục hành chính mới ban hành, Danh mục thủ tục hành chính bị bãi bỏ lĩnh vực đất đai"

YÊU CẦU ĐẦU RA (JSON thuần, không bọc markdown):
{
  "documentCode": "Số/Ký hiệu văn bản (VD: 4069/QĐ-UBND)",
  "documentDate": "Ngày ký ban hành văn bản (định dạng DD/MM/YYYY, VD: 06/09/2026. Lưu ý: lấy ngày ký ban hành của chính văn bản này ở cuối/phải, không lấy ngày các luật viện dẫn)",
  "issuerLevel": "tinh_tw",
  "title": "Lâm Đồng ban hành Quyết định số... công bố...",
  "contentHtml": "<p>UBND tỉnh Lâm Đồng ban hành Quyết định số... về việc công bố Danh mục thủ tục hành chính...</p><table style=\\"width:100%; border-collapse:collapse; margin:15px 0;\\" border=\\"1\\">...bảng tóm tắt các thủ tục hành chính và lĩnh vực...</table><p>Ủy ban nhân dân xã Đức An thông báo công khai để các cơ quan, tổ chức, cá nhân trên địa bàn được biết và thực hiện.</p>"
} `,

        // Mẫu cho chuyên mục: Công khai ngân sách
        'cong-khai-ngan-sach': `Bạn là chuyên viên quản trị Cổng thông tin điện tử UBND xã Đức An, tỉnh Lâm Đồng.
Nhiệm vụ: Đọc toàn bộ nội dung văn bản dưới đây (trích xuất từ file: "{filename}") và tạo bài viết cho mục "CÔNG KHAI NGÂN SÁCH".

Nội dung trích xuất:
"""
{extractedText}
"""

YÊU CẦU ĐẦU RA (JSON thuần, không bọc markdown):
{
  "documentCode": "Số/Ký hiệu văn bản (VD: 15/QĐ-UBND)",
  "documentDate": "Ngày ký ban hành văn bản (định dạng DD/MM/YYYY, VD: 06/09/2026. Lưu ý: lấy ngày ký ban hành của chính văn bản này ở cuối/phải, không lấy ngày các luật viện dẫn)",
  "issuerLevel": "xa",
  "title": "Tiêu đề chuẩn văn phong hành chính (VD: UBND xã Đức An ban hành Quyết định số... về việc công bố công khai tình hình thực hiện dự toán ngân sách...)",
  "contentHtml": "<p>Nội dung tóm tắt dẫn nhập...</p><table style=\\"width:100%; border-collapse:collapse; margin:15px 0;\\" border=\\"1\\">...thông tin trích yếu...</table><p>Kết luận triển khai thực hiện...</p>"
} `,

        // Mẫu mặc định cho các mục tin tức / văn bản chỉ đạo khác
        'default': `Bạn là chuyên viên quản trị Cổng thông tin điện tử cơ quan nhà nước (UBND xã Đức An, tỉnh Lâm Đồng).
Nhiệm vụ: Đọc toàn bộ nội dung văn bản dưới đây (trích xuất từ file: "{filename}") và tạo nội dung bài viết tin tức / văn bản chỉ đạo điều hành.

Nội dung trích xuất:
"""
{extractedText}
"""

YÊU CẦU ĐẦU RA (JSON thuần, không bọc markdown):
{
  "documentCode": "Số/Ký hiệu văn bản (VD: 4458/UBND-VP hoặc NQ số 42)",
  "documentDate": "Ngày ký ban hành văn bản (định dạng DD/MM/YYYY, VD: 06/09/2026. Lưu ý: lấy ngày ký ban hành của chính văn bản này ở cuối/phải, không lấy ngày các luật viện dẫn)",
  "issuerLevel": "Cấp ban hành: 'xa' (nếu là UBND/HĐND xã Đức An hoặc cơ quan cấp xã) hoặc 'tinh_tw' (nếu là UBND tỉnh Lâm Đồng, Sở, Bộ, Trung ương)",
  "title": "Tiêu đề bài viết trang trọng, đúng trích yếu văn bản",
  "contentHtml": "<p>Tóm tắt toàn bộ nội dung văn bản và chỉ đạo triển khai thực hiện...</p>"
} `
    };

    function getCurrentRouteKey() {
        const hash = (window.location.hash || window.location.pathname || '').split('?')[0];
        const clean = hash.replace(/^[#/]+|[#/]+$/g, '');
        if (clean.includes('cong-bo-danh-muc-tthc')) return 'cong-bo-danh-muc-tthc';
        if (clean.includes('cong-khai-ngan-sach')) return 'cong-khai-ngan-sach';
        const parts = clean.split('/');
        const lastSlug = parts[parts.length - 1] || 'default';
        return lastSlug;
    }

    async function fetchArticleTypesForCurrentCategory(categorySlug) {
        const slug = categorySlug || getCurrentRouteKey();
        if (!slug || slug === 'default') return [];
        const origin = window.location.origin;
        const authHeaders = getCmsAuthHeaders();

        return new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${origin}/api/News/ListLoaiTinTuc`);
            xhr.setRequestHeader('Content-Type', 'application/json');
            for (const h in authHeaders) xhr.setRequestHeader(h, authHeaders[h]);
            xhr.withCredentials = true;

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const res = JSON.parse(xhr.responseText);
                        if (res && res.Result && Array.isArray(res.Result) && res.Result.length > 0) {
                            currentArticleTypeId = res.Result[0].Id;
                            currentArticleTypeName = res.Result[0].Name;
                            resolve(res.Result);
                            return;
                        }
                    } catch (e) {}
                }
                resolve([]);
            };
            xhr.onerror = () => resolve([]);
            xhr.send(JSON.stringify({ Code: "NewsType", Value: slug }));
        });
    }

    function getPromptForCurrentUrl() {
        const routeKey = getCurrentRouteKey();
        const customPrompts = GM_getValue('CUSTOM_PROMPTS', {});
        if (customPrompts[routeKey]) return customPrompts[routeKey];
        if (customPrompts['default']) return customPrompts['default'];
        if (DEFAULT_PROMPTS[routeKey]) return DEFAULT_PROMPTS[routeKey];
        return DEFAULT_PROMPTS['default'];
    }

    function savePromptForCurrentUrl(promptText) {
        const routeKey = getCurrentRouteKey();
        const customPrompts = GM_getValue('CUSTOM_PROMPTS', {});
        customPrompts[routeKey] = promptText;
        GM_setValue('CUSTOM_PROMPTS', customPrompts);
    }

    function getTodayFormatted() {
        const today = new Date();
        const dd = String(today.getDate()).padStart(2, '0');
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const yyyy = today.getFullYear();
        return `${dd}-${mm}-${yyyy}`;
    }

    // ==========================================
    // 2. CSS GIAO DIỆN HIỆN ĐẠI
    // ==========================================
    GM_addStyle(`
        .da-auto-wrapper {
            position: fixed;
            top: 8px;
            left: 65px;
            z-index: 999999;
            font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        }
        .da-float-btn {
            background: linear-gradient(135deg, #0078d4, #005a9e);
            color: #fff;
            padding: 6px 15px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: 600;
            box-shadow: 0 2px 10px rgba(0, 120, 212, 0.4);
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: all 0.25s ease;
            border: 1px solid rgba(255,255,255,0.35);
        }
        .da-float-btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 15px rgba(0, 120, 212, 0.7);
            background: linear-gradient(135deg, #1084d8, #004c87);
        }
        .da-modal-box {
            display: none;
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 860px;
            max-width: 95vw;
            max-height: 92vh;
            overflow-y: auto;
            background: #ffffff;
            border-radius: 14px;
            box-shadow: 0 15px 40px rgba(0,0,0,0.3);
            z-index: 1000000;
            padding: 22px 24px;
            border: 1px solid #e0e0e0;
            animation: daFadeIn 0.2s ease-out;
            box-sizing: border-box;
            font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        }
        @keyframes daFadeIn {
            from { opacity: 0; transform: translate(-50%, -47%); }
            to { opacity: 1; transform: translate(-50%, -50%); }
        }
        .da-backdrop {
            display: none;
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.5);
            backdrop-filter: blur(2px);
            z-index: 999999;
        }
        .da-dropzone {
            border: 2px dashed #0078d4;
            border-radius: 10px;
            padding: 20px 15px;
            text-align: center;
            background: #f4f9ff;
            cursor: pointer;
            transition: all 0.2s;
            margin-top: 12px;
        }
        .da-dropzone.dragover {
            background: #e1effe;
            border-color: #005a9e;
            transform: scale(1.01);
        }
        .da-file-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
            font-size: 13px;
            background: #fff;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            overflow: hidden;
        }
        .da-file-table th {
            background: #f8fafc;
            padding: 8px 10px;
            text-align: left;
            font-weight: 600;
            color: #475569;
            border-bottom: 1px solid #e2e8f0;
        }
        .da-file-table td {
            padding: 8px 10px;
            border-bottom: 1px solid #f1f5f9;
            color: #334155;
            vertical-align: middle;
        }
        .da-file-table tr:last-child td {
            border-bottom: none;
        }
        .da-status-log {
            margin-top: 15px;
            max-height: 120px;
            overflow-y: auto;
            font-size: 12.5px;
            line-height: 1.6;
            color: #333;
            background: #f8f9fa;
            border-radius: 6px;
            padding: 10px;
            border: 1px solid #eaedf1;
        }
        .da-log-item {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .da-log-success { color: #107c41; font-weight: 500; }
        .da-log-info { color: #0078d4; }
        .da-log-error { color: #d83b01; font-weight: 500; }
        .da-btn-group {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
            margin-top: 15px;
        }
        .da-btn {
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            border: none;
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        .da-btn-default { background: #f3f3f3; color: #333; }
        .da-btn-default:hover { background: #e5e5e5; }
        .da-btn-primary { background: #0078d4; color: #fff; }
        .da-btn-primary:hover { background: #005a9e; }
        .da-btn-success { background: #107c41; color: #fff; }
        .da-btn-success:hover { background: #0b5a2f; }
        .da-btn-danger { background: #fee2e2; color: #dc2626; padding: 4px 8px; font-size: 11px; }
        .da-btn-danger:hover { background: #fecaca; }
        .da-preview-container {
            display: flex;
            gap: 15px;
            margin-top: 12px;
            align-items: center;
            background: #f0fdf4;
            padding: 10px 14px;
            border-radius: 8px;
            border: 1px solid #bbf7d0;
        }
        .da-preview-img {
            width: 75px;
            height: 105px;
            object-fit: cover;
            border-radius: 4px;
            border: 1px solid #ccc;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .da-tabs {
            display: flex;
            gap: 8px;
            border-bottom: 2px solid #e0e0e0;
            margin-top: 8px;
            margin-bottom: 12px;
            overflow-x: auto;
        }
        .da-tab-btn {
            padding: 8px 12px;
            cursor: pointer;
            font-size: 12.5px;
            font-weight: 600;
            border: none;
            background: none;
            color: #666;
            border-bottom: 2px solid transparent;
            margin-bottom: -2px;
            white-space: nowrap;
            display: inline-flex;
            align-items: center;
            gap: 4px;
        }
        .da-tab-btn.active {
            color: #0078d4;
            border-bottom-color: #0078d4;
        }
        .da-prompt-textarea {
            width: 100%;
            height: 180px;
            font-family: Consolas, monospace;
            font-size: 12px;
            padding: 10px;
            border: 1px solid #ccc;
            border-radius: 6px;
            box-sizing: border-box;
            resize: vertical;
        }
    `);

    // ==========================================
    // 3. KHỞI TẠO DOM GIAO DIỆN
    // ==========================================
    const container = document.createElement('div');
    container.className = 'da-auto-wrapper';
    container.style.display = 'none'; // Mặc định ẩn, chỉ hiển thị khi đã đăng nhập vào quản lý và có nút Thêm mới
    container.innerHTML = `
        <div class="da-float-btn" id="da-open-modal-btn">
            <span>✨</span> Kéo thả tài liệu AI
        </div>
    `;
    document.body.appendChild(container);

    const modalHTML = `
        <div class="da-backdrop" id="da-backdrop"></div>
        <div class="da-modal-box" id="da-modal">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <h3 style="margin: 0; font-size: 16px; color: #0078d4; font-weight: 700;">🚀 AI Đăng Tin & Quản Lý File Tự Động</h3>
                <span id="da-close-btn" style="cursor: pointer; font-size: 20px; color: #888;">&times;</span>
            </div>

            <div class="da-tabs">
                <button class="da-tab-btn active" id="da-tab-upload-btn">📂 Danh sách file & Xử lý</button>
                <button class="da-tab-btn" id="da-tab-history-btn">📜 Lịch sử văn bản (<span id="da-history-count-badge">0</span>)</button>
                <button class="da-tab-btn" id="da-tab-prompt-btn">📝 Tùy chỉnh Prompt URL</button>
                <button class="da-tab-btn" id="da-tab-settings-btn">⚙ Cấu hình AI</button>
            </div>
            
            <!-- TAB 1: DANH SÁCH FILE & XỬ LÝ -->
            <div id="da-tab-upload-content">
                <div style="font-size: 12px; color: #555; background: #eef6ff; padding: 6px 10px; border-radius: 4px; display: flex; justify-content: space-between;">
                    <span>📁 Thư mục lưu trữ: <b id="da-current-folder-badge">${getTodayFormatted()}</b> (theo Ngày đăng)</span>
                    <span>🌐 URL Key: <b id="da-current-route-badge">${getCurrentRouteKey()}</b></span>
                </div>

                <div class="da-dropzone" id="da-dropzone">
                    <div style="font-size: 26px; margin-bottom: 2px;">📄</div>
                    <div style="font-size: 13.5px; font-weight: 600; color: #0078d4;">Kéo thả nhiều file PDF, Word, Excel vào đây (hoặc bấm để chọn)</div>
                    <div style="font-size: 11.5px; color: #666; margin-top: 3px;">Có thể kéo thả nhiều lần để thêm tài liệu chính và các phụ lục</div>
                    <input type="file" id="da-file-input" multiple accept=".pdf,.docx,.doc,.xlsx,.xls,.jpg,.png" style="display: none;" />
                </div>

                <!-- CẢNH BÁO TRÙNG LẶP VĂN BẢN -->
                <div id="da-duplicate-alert" style="display: none; margin-top: 10px; padding: 10px 14px; background: #fffbeb; border: 1px solid #fde68a; border-left: 5px solid #f59e0b; border-radius: 6px; font-size: 12.5px; color: #92400e; line-height: 1.5;"></div>

                <!-- BẢNG DANH SÁCH FILE ĐÃ CHỌN -->
                <div id="da-file-table-container" style="display: none; margin-top: 12px;">
                    <div style="font-size: 13px; font-weight: 600; color: #1e293b; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
                        <span>📋 Danh sách tệp đã chọn (<span id="da-file-count">0</span>):</span>
                        <button class="da-btn da-btn-default" id="da-add-more-btn" style="padding: 4px 10px; font-size: 11.5px;">➕ Thêm file khác</button>
                    </div>
                    <table class="da-file-table">
                        <thead>
                            <tr>
                                <th>Tên tệp</th>
                                <th style="text-align: center; width: 110px;" title="Gửi nội dung file này cho Gemini AI phân tích">🤖 Gửi Gemini</th>
                                <th style="text-align: center; width: 90px;" title="Lấy trang 1 file này làm ảnh bìa đại diện">🖼️ Ảnh bìa</th>
                                <th style="text-align: center; width: 45px;">Xóa</th>
                            </tr>
                        </thead>
                        <tbody id="da-file-table-body"></tbody>
                    </table>

                    <div style="margin-top: 14px;">
                        <button class="da-btn da-btn-success" id="da-start-process-btn" style="font-size: 13.5px; padding: 10px 20px; width: 100%; justify-content: center;">
                            🚀 Bắt đầu Phân tích AI & Điền vào Form
                        </button>
                    </div>
                </div>

                <div id="da-preview-area" class="da-preview-container" style="display: none;">
                    <img id="da-cover-preview" class="da-preview-img" alt="Ảnh bìa trang 1" />
                    <div style="flex: 1; font-size: 13px;">
                        <div style="font-weight: 600; color: #107c41;">✓ Đã tạo ảnh bìa từ Trang 1 PDF</div>
                        <div id="da-preview-info" style="color: #475569; margin-top: 4px; font-size: 12px;"></div>
                    </div>
                </div>

                <div class="da-status-log" id="da-status-log">
                    <div class="da-log-item da-log-info">Sẵn sàng. Hãy kéo thả file vào khung phía trên.</div>
                </div>
            </div>

            <!-- TAB 2: LỊCH SỬ SỐ HIỆU VĂN BẢN & KIỂM TRA TRÙNG -->
            <div id="da-tab-history-content" style="display: none;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <div style="font-size: 12.5px; color: #475569; font-weight: 600;">
                        Danh sách số hiệu văn bản đã đăng tải trên trình duyệt:
                    </div>
                    <button class="da-btn da-btn-default" id="da-add-history-manual-btn" style="padding: 4px 8px; font-size: 11.5px; color: #0284c7; border: 1px solid #bae6fd;">
                        ➕ Thêm số hiệu thủ công
                    </button>
                </div>

                <input type="text" id="da-history-search-input" placeholder="🔍 Nhập số hiệu (VD: 4458, 4069...), tên file hoặc tiêu đề để tìm nhanh..." style="width: 100%; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 6px; box-sizing: border-box; margin-bottom: 10px; font-size: 12.5px;" />

                <div style="max-height: 280px; overflow-y: auto; border: 1px solid #e2e8f0; border-radius: 6px;">
                    <table class="da-file-table" style="margin: 0;">
                        <thead>
                            <tr style="position: sticky; top: 0; background: #f8fafc; z-index: 2;">
                                <th style="width: 120px;">Số hiệu</th>
                                <th>Tiêu đề bài viết</th>
                                <th style="width: 130px; text-align: center;">Ngày đăng</th>
                                <th style="width: 40px; text-align: center;">Xóa</th>
                            </tr>
                        </thead>
                        <tbody id="da-history-table-body"></tbody>
                    </table>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 10px;">
                    <button class="da-btn da-btn-default" id="da-clear-history-btn" style="font-size: 11.5px; color: #dc2626;">
                        🗑 Xóa toàn bộ lịch sử
                    </button>
                    <button class="da-btn da-btn-default" id="da-export-history-btn" style="font-size: 11.5px; color: #059669;">
                        📥 Xuất danh sách (CSV)
                    </button>
                </div>
            </div>

            <!-- TAB 3: TÙY CHỈNH PROMPT -->
            <div id="da-tab-prompt-content" style="display: none;">
                <div style="font-size: 12px; color: #444; margin-bottom: 8px;">
                    Prompt cho URL: <b style="color:#0078d4;" id="da-prompt-route-name">...</b>
                    <span style="color:#888;">(Biến hỗ trợ: {filename}, {extractedText})</span>
                </div>
                <textarea id="da-prompt-input" class="da-prompt-textarea"></textarea>
                <div style="display: flex; justify-content: space-between; margin-top: 10px;">
                    <button class="da-btn da-btn-default" id="da-reset-prompt-btn">🔄 Khôi phục mặc định</button>
                    <button class="da-btn da-btn-primary" id="da-save-prompt-btn">💾 Lưu Prompt cho URL này</button>
                </div>
            </div>

            <!-- TAB 4: CẤU HÌNH API KEY, MODEL & HÌNH ẢNH -->
            <div id="da-tab-settings-content" style="display: none; padding-top: 10px;">
                <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 6px;">Mô hình Gemini AI:</label>
                <select id="da-gemini-model-select" style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; margin-bottom: 12px; font-size: 13px;">
                    <option value="gemini-3.6-flash">Gemini 3.6 Flash (Khuyên dùng: Chuẩn API, siêu nhanh & thông minh)</option>
                    <option value="gemini-3.7-flash">Gemini 3.7 Flash</option>
                    <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
                    <option value="gemini-1.5-flash">Gemini 1.5 Flash (Dự phòng)</option>
                    <option value="gemini-1.5-pro">Gemini 1.5 Pro (Dự phòng)</option>
                </select>

                <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 6px;">Tối ưu Dung lượng & Tốc độ tải Ảnh bìa (Trang 1 PDF):</label>
                <select id="da-cover-quality-select" style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; margin-bottom: 12px; font-size: 13px;">
                    <option value="fast">⚡ Siêu nhẹ (~60-90KB) - Tải trang web cực nhanh (Khuyên dùng)</option>
                    <option value="balanced">⚖ Cân bằng (~120-180KB) - Chuẩn bài viết tin tức</option>
                    <option value="high">🎨 Chất lượng cao (~250-350KB) - Rất sắc nét</option>
                    <option value="max">🖼️ Gốc nét tối đa (~600KB - 1.5MB) - Không nén</option>
                </select>

                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                    <label style="font-size: 13px; font-weight: 600; margin: 0;">Danh sách Google Gemini API Keys (Hỗ trợ nhiều Key):</label>
                    <span id="da-key-count-info" style="font-size: 12px; color: #107c41; font-weight: 600;">0 key (0 lượt/ngày)</span>
                </div>
                <textarea id="da-gemini-key-input" style="width: 100%; height: 85px; padding: 8px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; font-family: Consolas, monospace; font-size: 12px; resize: vertical;" placeholder="Nhập một hoặc nhiều API Key (mỗi dòng 1 key, hoặc cách nhau bởi dấu phẩy):
AIzaSy...Key1...
AIzaSy...Key2...
AIzaSy...Key3..."></textarea>
                <div style="font-size: 12px; color: #64748b; margin-top: 4px; line-height: 1.4;">
                    💡 <i>Mẹo: Nhập nhiều key giúp tự động chuyển đổi dự phòng khi một key hết hạn mức (mỗi key +1.500 lượt/ngày). Key được lưu bảo mật trong trình duyệt.</i>
                </div>
                <div style="text-align: right; margin-top: 12px;">
                    <button class="da-btn da-btn-primary" id="da-save-key-btn">💾 Lưu Cấu hình Toàn diện</button>
                </div>
            </div>

            <div class="da-btn-group" style="display: flex; justify-content: space-between; align-items: center; margin-top: 18px; border-top: 1px solid #e2e8f0; padding-top: 12px;">
                <button class="da-btn da-btn-default" id="da-reset-all-btn" style="font-size: 13px; font-weight: 600; color: #dc2626; border: 1px solid #fca5a5; background: #fff5f5; padding: 8px 18px;" title="Xóa toàn bộ file và nhật ký để bắt đầu bài viết mới">🔄 Làm lại từ đầu</button>
                <button class="da-btn da-btn-default" id="da-close-btn2" style="padding: 8px 20px;">Đóng</button>
            </div>
        </div>
    `;

    const modalContainer = document.createElement('div');
    modalContainer.innerHTML = modalHTML;
    document.body.appendChild(modalContainer);

    // Elements
    const modal = document.getElementById('da-modal');
    const backdrop = document.getElementById('da-backdrop');
    const openBtn = document.getElementById('da-open-modal-btn');
    const closeBtn = document.getElementById('da-close-btn');
    const closeBtn2 = document.getElementById('da-close-btn2');
    const dropzone = document.getElementById('da-dropzone');
    const fileInput = document.getElementById('da-file-input');
    const statusLog = document.getElementById('da-status-log');
    const previewArea = document.getElementById('da-preview-area');
    const coverPreview = document.getElementById('da-cover-preview');
    const previewInfo = document.getElementById('da-preview-info');
    const fileTableContainer = document.getElementById('da-file-table-container');
    const fileTableBody = document.getElementById('da-file-table-body');
    const fileCountSpan = document.getElementById('da-file-count');
    const addMoreBtn = document.getElementById('da-add-more-btn');
    const startProcessBtn = document.getElementById('da-start-process-btn');

    // Tabs elements
    const tabUploadBtn = document.getElementById('da-tab-upload-btn');
    const tabHistoryBtn = document.getElementById('da-tab-history-btn');
    const tabPromptBtn = document.getElementById('da-tab-prompt-btn');
    const tabSettingsBtn = document.getElementById('da-tab-settings-btn');
    const tabUploadContent = document.getElementById('da-tab-upload-content');
    const tabHistoryContent = document.getElementById('da-tab-history-content');
    const tabPromptContent = document.getElementById('da-tab-prompt-content');
    const tabSettingsContent = document.getElementById('da-tab-settings-content');
    const promptInput = document.getElementById('da-prompt-input');
    const promptRouteName = document.getElementById('da-prompt-route-name');
    const savePromptBtn = document.getElementById('da-save-prompt-btn');
    const resetPromptBtn = document.getElementById('da-reset-prompt-btn');
    const geminiKeyInput = document.getElementById('da-gemini-key-input');
    const geminiModelSelect = document.getElementById('da-gemini-model-select');
    const coverQualitySelect = document.getElementById('da-cover-quality-select');
    const saveKeyBtn = document.getElementById('da-save-key-btn');
    const currentRouteBadge = document.getElementById('da-current-route-badge');
    const duplicateAlert = document.getElementById('da-duplicate-alert');
    const historyCountBadge = document.getElementById('da-history-count-badge');
    const historyTableBody = document.getElementById('da-history-table-body');
    const historySearchInput = document.getElementById('da-history-search-input');
    const addHistoryManualBtn = document.getElementById('da-add-history-manual-btn');
    const clearHistoryBtn = document.getElementById('da-clear-history-btn');
    const exportHistoryBtn = document.getElementById('da-export-history-btn');
    const keyCountInfo = document.getElementById('da-key-count-info');

    // ==========================================
    // CẤU HÌNH TỐI ƯU HÓA CHẤT LƯỢNG ẢNH BÌA
    // ==========================================
    function getCoverQualityConfig() {
        const mode = GM_getValue('COVER_IMAGE_QUALITY', 'fast');
        switch (mode) {
            case 'fast':
                return { scale: 1.0, quality: 0.75, label: 'Siêu nhẹ (~60-90KB - Tải trang cực nhanh)' };
            case 'balanced':
                return { scale: 1.25, quality: 0.82, label: 'Cân bằng (~120-180KB)' };
            case 'high':
                return { scale: 1.5, quality: 0.88, label: 'Chất lượng cao (~250-350KB)' };
            case 'max':
                return { scale: 2.0, quality: 0.92, label: 'Gốc nét tối đa (~1MB)' };
            default:
                return { scale: 1.0, quality: 0.75, label: 'Siêu nhẹ (~60-90KB - Tải trang cực nhanh)' };
        }
    }

    // ==========================================
    // QUẢN LÝ KHO GEMINI API KEYS & FALLBACK POOL
    // ==========================================
    function getApiKeyList() {
        const rawKeys = GM_getValue('GEMINI_API_KEYS', null);
        if (Array.isArray(rawKeys) && rawKeys.length > 0) {
            return rawKeys.map(k => k.trim()).filter(k => k.length > 10);
        }
        const singleKey = GM_getValue('GEMINI_API_KEY', '');
        if (singleKey && typeof singleKey === 'string' && singleKey.trim().length > 10) {
            const parts = singleKey.split(/[\n,;]+/).map(k => k.trim()).filter(k => k.length > 10);
            return parts.length > 0 ? parts : [singleKey.trim()];
        }
        return [];
    }

    function saveApiKeyList(keysText) {
        if (!keysText) {
            GM_setValue('GEMINI_API_KEYS', []);
            GM_setValue('GEMINI_API_KEY', '');
            updateKeyCountInfo();
            return [];
        }
        const cleanKeys = Array.from(new Set(
            keysText.split(/[\n,;]+/).map(k => k.trim()).filter(k => k.length > 10)
        ));
        GM_setValue('GEMINI_API_KEYS', cleanKeys);
        GM_setValue('GEMINI_API_KEY', cleanKeys.join('\n'));
        updateKeyCountInfo();
        return cleanKeys;
    }

    function updateKeyCountInfo() {
        const keys = getApiKeyList();
        if (keyCountInfo) {
            const totalPerDay = keys.length * 1500;
            keyCountInfo.textContent = `${keys.length} key (${totalPerDay.toLocaleString()} lượt/ngày)`;
            keyCountInfo.style.color = keys.length > 0 ? '#107c41' : '#dc2626';
        }
    }
    function getDocumentHistory() {
        return GM_getValue('PUBLISHED_DOCUMENT_HISTORY', []);
    }

    function saveDocumentHistory(historyList) {
        GM_setValue('PUBLISHED_DOCUMENT_HISTORY', historyList);
        updateHistoryCountBadge();
    }

    function updateHistoryCountBadge() {
        const list = getDocumentHistory();
        if (historyCountBadge) historyCountBadge.textContent = list.length;
    }

    function extractDocumentCode(text, filename = '') {
        const combined = `${filename || ''} ${text || ''}`;
        const patterns = [
            /(?:Số|số|NQ\s*số|QĐ\s*số|CV\s*số|Nghị\s*quyết\s*số|Quyết\s*định\s*số)\s*[:.]?\s*([0-9A-ZĐa-zđ\-_]+(?:\s*\/\s*[0-9A-ZĐa-zđ\-_]+)+|[0-9A-ZĐa-zđ\-_/]+)/i,
            /([0-9]{1,5}\s*\/[0-9A-ZĐa-zđ\-_/]+)/i,
            /([0-9]{1,5}\-[0-9A-ZĐa-zđ\-_/]+)/i,
            /([0-9]{2,6})/i
        ];
        for (const pat of patterns) {
            const m = combined.match(pat);
            if (m && m[1] && m[1].length >= 2) {
                return m[1].replace(/\s*\/\s*/g, '/').trim();
            }
        }
        return '';
    }

    function checkDuplicateDocument(queryCode, filename = '') {
        if (!queryCode && !filename) return null;
        const history = getDocumentHistory();
        const normQuery = queryCode ? queryCode.toLowerCase().replace(/[\s\-_/.]/g, '') : '';
        const normFile = filename ? filename.toLowerCase().replace(/[\s\-_/.]/g, '') : '';

        for (const item of history) {
            const itemNormCode = (item.code || '').toLowerCase().replace(/[\s\-_/.]/g, '');
            const itemNormFile = (item.fileName || '').toLowerCase().replace(/[\s\-_/.]/g, '');

            if (normQuery && normQuery.length >= 2 && itemNormCode && (itemNormCode.includes(normQuery) || normQuery.includes(itemNormCode))) {
                return item;
            }
            if (normFile && normFile.length >= 4 && itemNormFile && (itemNormFile.includes(normFile) || normFile.includes(itemNormFile))) {
                return item;
            }
        }
        return null;
    }

    function recordPublishedDocument(code, title, fileName) {
        if (!title && !code && !fileName) return;
        const history = getDocumentHistory();
        const detectedCode = code || extractDocumentCode(title, fileName) || fileName;
        
        const existingIdx = history.findIndex(it => (it.code && it.code.toLowerCase() === detectedCode.toLowerCase()) || (it.title && it.title.toLowerCase() === (title || '').toLowerCase()));
        const record = {
            id: Date.now().toString(),
            code: detectedCode,
            title: title || '',
            fileName: fileName || '',
            publishedAt: new Date().toLocaleString('vi-VN'),
            category: getCurrentRouteKey()
        };

        if (existingIdx >= 0) {
            history[existingIdx] = record;
        } else {
            history.unshift(record);
        }
        if (history.length > 500) history.pop();
        saveDocumentHistory(history);
        renderHistoryTab();
    }

    function renderHistoryTab(filterQuery = '') {
        const history = getDocumentHistory();
        updateHistoryCountBadge();
        if (!historyTableBody) return;
        historyTableBody.innerHTML = '';

        const query = filterQuery.trim().toLowerCase();
        const filtered = query ? history.filter(it => 
            (it.code && it.code.toLowerCase().includes(query)) ||
            (it.title && it.title.toLowerCase().includes(query)) ||
            (it.fileName && it.fileName.toLowerCase().includes(query)) ||
            (it.category && it.category.toLowerCase().includes(query))
        ) : history;

        if (filtered.length === 0) {
            historyTableBody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding: 20px; color: #888; font-style: italic;">Chưa có dữ liệu lịch sử nào${query ? ' khớp với tìm kiếm' : ''}.</td></tr>`;
            return;
        }

        filtered.forEach((item, index) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><b style="color: #0078d4; font-size: 12.5px;">${item.code || '(Chưa rõ)'}</b></td>
                <td style="font-size: 12px; color: #334155;" title="${item.title || item.fileName}">
                    <div style="font-weight: 500; margin-bottom: 2px;">${item.title || item.fileName}</div>
                    <div style="font-size: 11px; color: #64748b;">Tệp: ${item.fileName || '---'} | Mục: ${item.category || '---'}</div>
                </td>
                <td style="text-align: center; font-size: 11.5px; color: #64748b;">${item.publishedAt || '---'}</td>
                <td style="text-align: center;">
                    <button class="da-btn da-btn-danger" data-id="${item.id}" style="padding: 2px 6px; font-size: 10.5px;">✕</button>
                </td>
            `;
            tr.querySelector('button').onclick = () => {
                const updated = history.filter(h => h.id !== item.id);
                saveDocumentHistory(updated);
                renderHistoryTab(historySearchInput ? historySearchInput.value : '');
            };
            historyTableBody.appendChild(tr);
        });
    }

    // Quản lý danh sách file đã nạp vào & dữ liệu ảnh bìa
    let stagedFiles = []; // { id, file, sendToGemini: boolean, isCover: boolean }
    let coverImageBlob = null;
    let coverFileName = '';

    function switchTab(activeTab) {
        [tabUploadBtn, tabHistoryBtn, tabPromptBtn, tabSettingsBtn].forEach(b => b.classList.remove('active'));
        tabUploadContent.style.display = 'none';
        tabHistoryContent.style.display = 'none';
        tabPromptContent.style.display = 'none';
        tabSettingsContent.style.display = 'none';

        if (activeTab === 'upload') {
            tabUploadBtn.classList.add('active');
            tabUploadContent.style.display = 'block';
            currentRouteBadge.textContent = getCurrentRouteKey();
        } else if (activeTab === 'history') {
            tabHistoryBtn.classList.add('active');
            tabHistoryContent.style.display = 'block';
            renderHistoryTab(historySearchInput ? historySearchInput.value : '');
        } else if (activeTab === 'prompt') {
            tabPromptBtn.classList.add('active');
            tabPromptContent.style.display = 'block';
            const routeKey = getCurrentRouteKey();
            promptRouteName.textContent = routeKey;
            promptInput.value = getPromptForCurrentUrl();
        } else if (activeTab === 'settings') {
            tabSettingsBtn.classList.add('active');
            tabSettingsContent.style.display = 'block';
            const keys = getApiKeyList();
            geminiKeyInput.value = keys.join('\n');
            updateKeyCountInfo();
            let currentModel = GM_getValue('GEMINI_MODEL', 'gemini-3.6-flash');
            if (currentModel === 'gemini-2.0-flash') currentModel = 'gemini-3.6-flash';
            geminiModelSelect.value = currentModel;
            if (coverQualitySelect) {
                coverQualitySelect.value = GM_getValue('COVER_IMAGE_QUALITY', 'fast');
            }
        }
    }

    tabUploadBtn.onclick = () => switchTab('upload');
    tabHistoryBtn.onclick = () => switchTab('history');
    tabPromptBtn.onclick = () => switchTab('prompt');
    tabSettingsBtn.onclick = () => switchTab('settings');

    if (geminiKeyInput) {
        geminiKeyInput.oninput = () => {
            const raw = geminiKeyInput.value;
            const keys = raw.split(/[\n,;]+/).map(k => k.trim()).filter(k => k.length > 10);
            if (keyCountInfo) {
                const totalPerDay = keys.length * 1500;
                keyCountInfo.textContent = `${keys.length} key (${totalPerDay.toLocaleString()} lượt/ngày)`;
                keyCountInfo.style.color = keys.length > 0 ? '#107c41' : '#dc2626';
            }
        };
    }

    if (historySearchInput) {
        historySearchInput.oninput = () => renderHistoryTab(historySearchInput.value);
    }

    if (addHistoryManualBtn) {
        addHistoryManualBtn.onclick = () => {
            const code = prompt('Nhập Số hiệu / Ký hiệu văn bản (Ví dụ: 4458/UBND-VP, 4069/QĐ-UBND):');
            if (code && code.trim()) {
                const title = prompt('Nhập Tiêu đề hoặc Trích yếu văn bản (tùy chọn):') || '';
                recordPublishedDocument(code.trim(), title.trim(), '');
                logStatus(`Đã thêm số hiệu "${code.trim()}" vào lịch sử kiểm tra trùng!`, 'success');
            }
        };
    }

    if (clearHistoryBtn) {
        clearHistoryBtn.onclick = () => {
            if (confirm('Bạn có chắc chắn muốn XÓA TOÀN BỘ lịch sử số hiệu văn bản đã lưu trên trình duyệt?')) {
                saveDocumentHistory([]);
                renderHistoryTab();
                logStatus('Đã xóa toàn bộ lịch sử số hiệu văn bản.', 'info');
            }
        };
    }

    if (exportHistoryBtn) {
        exportHistoryBtn.onclick = () => {
            const list = getDocumentHistory();
            if (list.length === 0) {
                alert('Chưa có lịch sử văn bản nào để xuất!');
                return;
            }
            let csv = '\uFEFFSố hiệu,Tiêu đề,Tệp gốc,Chuyên mục,Ngày đăng\n';
            list.forEach(r => {
                csv += `"${(r.code || '').replace(/"/g, '""')}","${(r.title || '').replace(/"/g, '""')}","${(r.fileName || '').replace(/"/g, '""')}","${(r.category || '').replace(/"/g, '""')}","${r.publishedAt || ''}"\n`;
            });
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `lich_su_so_hieu_van_ban_${getTodayFormatted()}.csv`;
            a.click();
        };
    }

    savePromptBtn.onclick = () => {
        savePromptForCurrentUrl(promptInput.value);
        logStatus(`Đã lưu tùy chỉnh Prompt cho URL: "${getCurrentRouteKey()}"!`, 'success');
        switchTab('upload');
    };

    resetPromptBtn.onclick = () => {
        const routeKey = getCurrentRouteKey();
        const defaultText = DEFAULT_PROMPTS[routeKey] || DEFAULT_PROMPTS['default'];
        promptInput.value = defaultText;
        savePromptForCurrentUrl(defaultText);
        logStatus('Đã khôi phục Prompt mặc định!', 'info');
    };

    saveKeyBtn.onclick = () => {
        const savedKeys = saveApiKeyList(geminiKeyInput.value);
        GM_setValue('GEMINI_MODEL', geminiModelSelect.value);
        if (coverQualitySelect) {
            GM_setValue('COVER_IMAGE_QUALITY', coverQualitySelect.value);
        }
        const qualityText = coverQualitySelect ? coverQualitySelect.options[coverQualitySelect.selectedIndex].text.split('-')[0].trim() : '';
        logStatus(`Đã lưu ${savedKeys.length} API Key (Hạn mức: ${(savedKeys.length * 1500).toLocaleString()} req/ngày), Model (${geminiModelSelect.value}) & Ảnh bìa (${qualityText})!`, 'success');
        switchTab('upload');
    };

    function showModal() {
        modal.style.display = 'block';
        backdrop.style.display = 'block';
        currentRouteBadge.textContent = getCurrentRouteKey();
        updateHistoryCountBadge();
        updateKeyCountInfo();
    }
    function hideModal() {
        modal.style.display = 'none';
        backdrop.style.display = 'none';
    }

    updateHistoryCountBadge();

    // ==========================================
    // 3.1 BỘ QUẢN LÝ HIỂN THỊ NÚT
    // Chỉ hiển thị khi đã đăng nhập vào quản lý và có nút Thêm mới, ẩn ở trang login
    // ==========================================
    function normalizeVn(str) {
        return (str || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/g, 'd')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function generateSlug(str) {
        return normalizeVn(str)
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    function isElementVisible(el) {
        if (!el) return false;
        if (el.offsetParent !== null) return true;
        const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
        if (style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }
        return false;
    }

    function isUserLoggedInAndInAdmin() {
        const hash = (window.location.hash || '').toLowerCase();
        const pathname = (window.location.pathname || '').toLowerCase();

        // 1. Nếu đang ở URL login -> ẩn hoàn toàn
        if (hash.includes('login') || pathname.includes('login')) {
            return false;
        }

        // 2. Nếu trên trang đang có form đăng nhập / ô nhập OTP -> ẩn hoàn toàn
        if (document.querySelector('input[placeholder*="OTP" i]') || document.querySelector('form[action*="login" i]')) {
            return false;
        }

        // 3. Kiểm tra các thành phần giao diện chỉ xuất hiện khi đã đăng nhập thành công
        // (app-user-dropdown-menu, user-menu, Admin quản trị, app-header...)
        const userMenu = document.querySelector('app-user-dropdown-menu, .user-menu, li.user-menu, app-header, .main-header');
        if (userMenu) {
            return true;
        }

        // Hoặc kiểm tra headers / token xác thực nếu đã bắt được
        if (liveCmsHeaders['authorization'] || liveCmsHeaders['token']) {
            return true;
        }

        return false;
    }

    function isArticleFormCurrentlyOpen() {
        // 1. Kiểm tra trường Tiêu đề, Alias, Ngày đăng hoặc bất kỳ input đặc trưng nào của form bài viết
        const formInputs = document.querySelectorAll('input[placeholder*="tiêu đề" i], input[placeholder*="title" i], input[formcontrolname*="title" i], input[formcontrolname*="name" i], input[name*="title" i], input[id*="title" i], input[id*="tieude" i], input[ng-model*="Title" i], input[formcontrolname*="alias" i], input[placeholder*="alias" i]');
        for (const inp of formInputs) {
            if (!inp.closest('#da-modal, .da-auto-wrapper') && isElementVisible(inp)) return true;
        }

        // 2. Kiểm tra sự xuất hiện của nút "Lưu thay đổi" / "Lưu bài viết" / "Lưu lại"
        const saveBtns = document.querySelectorAll('button, a, .btn');
        for (const btn of saveBtns) {
            if (btn.closest('#da-modal, .da-auto-wrapper')) continue;
            const t = (btn.textContent || '').trim().toLowerCase();
            if ((t.includes('lưu thay đổi') || t.includes('lưu bài viết') || t.includes('lưu lại') || t === 'lưu') && isElementVisible(btn)) {
                return true;
            }
        }

        // 3. Kiểm tra nút "Chọn hình ảnh" hoặc CKEditor
        const imgBtns = document.querySelectorAll('button, a, .btn');
        for (const btn of imgBtns) {
            if (btn.closest('#da-modal, .da-auto-wrapper')) continue;
            const t = (btn.textContent || '').trim().toLowerCase();
            if (t.includes('chọn hình') && isElementVisible(btn)) return true;
        }

        const cke = document.querySelector('.cke, ckeditor, #cke_Content, #cke_content');
        if (cke && isElementVisible(cke) && !cke.closest('#da-modal, .da-auto-wrapper')) {
            return true;
        }

        // 4. Kiểm tra Modal Dialog của CMS (PrimeNG / Bootstrap)
        const cmsDialogs = document.querySelectorAll('.p-dialog, .modal.show, [role="dialog"], app-news-detail, app-them-moi');
        for (const dlg of cmsDialogs) {
            if (dlg.closest('#da-modal, .da-auto-wrapper')) continue;
            if (isElementVisible(dlg)) return true;
        }

        return false;
    }

    function hasAddNewButtonOrForm() {
        // 1. Kiểm tra nếu form "Thêm mới tin tức / bài viết" đang mở sẵn
        if (isArticleFormCurrentlyOpen()) {
            return true;
        }

        // 2. Quét các nút hoặc liên kết "+ Thêm mới" trên trang quản lý
        const candidateEls = document.querySelectorAll('button, a, .btn, [role="button"]');
        for (const el of candidateEls) {
            if (el.closest('#da-modal, .da-auto-wrapper')) continue;
            const text = (el.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
            const title = (el.getAttribute('title') || '').toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            if (text.includes('thêm mới') || title.includes('thêm mới') || aria.includes('thêm mới') || normalizeVn(text).includes('them moi')) {
                if (isElementVisible(el)) {
                    return true;
                }
            }
        }
        return false;
    }

    function updateButtonVisibility() {
        const shouldShow = isUserLoggedInAndInAdmin() && hasAddNewButtonOrForm();
        if (shouldShow) {
            if (container.style.display === 'none') {
                container.style.display = 'block';
            }
        } else {
            if (container.style.display !== 'none') {
                container.style.display = 'none';
                if (modal && modal.style.display !== 'none') {
                    hideModal();
                }
            }
        }
    }

    window.addEventListener('hashchange', () => {
        if (currentRouteBadge) currentRouteBadge.textContent = getCurrentRouteKey();
        updateButtonVisibility();
    });
    window.addEventListener('popstate', () => {
        updateButtonVisibility();
    });

    // Theo dõi thay đổi DOM khi Angular render component hoặc view mới
    let daDomCheckTimer = null;
    const daDomObserver = new MutationObserver(() => {
        if (daDomCheckTimer) clearTimeout(daDomCheckTimer);
        daDomCheckTimer = setTimeout(() => {
            updateButtonVisibility();
            localizeCalendarDOM();
            configurePrimeNgLocale();
        }, 150);
    });
    daDomObserver.observe(document.body, { childList: true, subtree: true });

    // Kiểm tra định kỳ (fallback)
    setInterval(() => {
        updateButtonVisibility();
        localizeCalendarDOM();
        configurePrimeNgLocale();
    }, 1000);

    // Bắt sự kiện click trên toàn trang để việt hoá lịch ngay lập tức khi người dùng bấm mở
    document.addEventListener('click', (e) => {
        if (e.target.closest('p-calendar, .p-datepicker, .p-datepicker-trigger, button, a')) {
            setTimeout(localizeCalendarDOM, 10);
            setTimeout(localizeCalendarDOM, 50);
            setTimeout(localizeCalendarDOM, 150);
            setTimeout(localizeCalendarDOM, 300);
        }
    }, true);

    // Đồng bộ giá trị Ngày đăng nếu người dùng tự chỉnh sửa thủ công trên Form
    const handleDateManualInput = (e) => {
        if (!e.isTrusted) return; // Chỉ nhận tương tác thực tế từ người dùng, bỏ qua các event do script tự dispatch
        const inp = e.target;
        if (inp && inp.tagName === 'INPUT' && !inp.closest('#da-modal, .da-auto-wrapper')) {
            const pCal = inp.closest('p-calendar');
            const fcName = (inp.getAttribute('formcontrolname') || '').toLowerCase();
            if (pCal || fcName.includes('date') || fcName.includes('publish') || (inp.value && inp.value.includes('/') && inp.value.length >= 10)) {
                if (inp.value && inp.value.trim().length >= 8) {
                    currentPublishDateStr = inp.value.trim();
                    isDateManuallyEditedByUser = true;
                }
            }
        }
    };
    document.addEventListener('input', handleDateManualInput, true);
    document.addEventListener('change', handleDateManualInput, true);

    // Kích hoạt kiểm tra ngay khi nạp trang
    updateButtonVisibility();
    localizeCalendarDOM();
    configurePrimeNgLocale();

    openBtn.onclick = showModal;
    closeBtn.onclick = hideModal;
    closeBtn2.onclick = hideModal;
    backdrop.onclick = hideModal;
    addMoreBtn.onclick = () => fileInput.click();

    const resetAllBtn = document.getElementById('da-reset-all-btn');

    function resetAll() {
        stagedFiles = [];
        coverImageBlob = null;
        coverFileName = '';
        currentUploadedAvatarUrl = '';
        currentEditorContentHtml = '';
        currentArticleTitleText = '';
        currentArticleTypeId = '';
        currentArticleTypeName = '';
        currentPublishDateStr = '';
        isDateManuallyEditedByUser = false;
        if (duplicateAlert) {
            duplicateAlert.style.display = 'none';
            duplicateAlert.innerHTML = '';
        }
        if (fileTableContainer) fileTableContainer.style.display = 'none';
        if (fileTableBody) fileTableBody.innerHTML = '';
        if (fileCountSpan) fileCountSpan.textContent = '0';
        if (previewArea) previewArea.style.display = 'none';
        if (coverPreview) coverPreview.src = '';
        if (previewInfo) previewInfo.textContent = '';
        if (fileInput) fileInput.value = '';
        if (statusLog) {
            statusLog.innerHTML = '<div class="da-log-item da-log-info"><span>ℹ</span> Sẵn sàng. Hãy kéo thả file vào khung phía trên.</div>';
        }
        if (startProcessBtn) {
            startProcessBtn.disabled = false;
            startProcessBtn.textContent = '🚀 Bắt đầu Phân tích AI & Điền vào Form';
        }
        logStatus('Đã làm lại từ đầu! Hãy kéo thả file mới vào khung.', 'info');
    }

    if (resetAllBtn) {
        resetAllBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            resetAll();
        };
    }

    // Tự động Reset toàn bộ tệp và modal sau khi người dùng bấm "Lưu thay đổi" bài viết
    document.addEventListener('click', (e) => {
        const target = e.target.closest('button, a, input[type="submit"]');
        if (target && target.textContent) {
            const txt = target.textContent.trim().toLowerCase();
            if (txt.includes('lưu thay đổi') || txt.includes('lưu bài viết') || txt.includes('lưu và đóng') || txt.includes('lưu lại')) {
                // Đợi 1.2s sau khi gửi lưu xong sẽ tự động dọn sạch dữ liệu cũ
                setTimeout(() => {
                    resetAll();
                    hideModal();
                }, 1200);
            }
        }
    }, true);

    function logStatus(msg, type = 'info') {
        const item = document.createElement('div');
        item.className = `da-log-item da-log-${type}`;
        item.innerHTML = `<span>${type === 'success' ? '✔' : type === 'error' ? '✖' : 'ℹ'}</span> ${msg}`;
        statusLog.appendChild(item);
        statusLog.scrollTop = statusLog.scrollHeight;
    }

    // ==========================================
    // 4. QUẢN LÝ FILE STAGING & BẢNG FILE
    // ==========================================
    // Chặn hoàn toàn hành vi của trình duyệt tự mở file sang tab mới trên toàn trang
    window.addEventListener('dragover', (e) => {
        e.preventDefault();
    }, false);

    window.addEventListener('drop', (e) => {
        e.preventDefault();
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            // Tự động nhận file nếu thả vào modal hoặc thả khi nút/modal đang hiển thị
            const isModalVisible = modal && modal.style.display === 'block';
            const isButtonVisible = container && container.style.display !== 'none';
            if ((isModalVisible || isButtonVisible) && (isModalVisible || e.target.closest('#da-modal, #da-dropzone, .da-auto-wrapper'))) {
                addFilesToStaging(Array.from(e.dataTransfer.files));
                if (!isModalVisible) showModal();
            }
        }
    }, false);

    dropzone.onclick = (e) => {
        if (e.target.tagName !== 'INPUT') fileInput.click();
    };
    dropzone.ondragover = (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    };
    dropzone.ondragleave = () => dropzone.classList.remove('dragover');
    dropzone.ondrop = (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            addFilesToStaging(Array.from(e.dataTransfer.files));
        }
    };
    fileInput.onchange = (e) => {
        if (e.target.files && e.target.files.length > 0) {
            addFilesToStaging(Array.from(e.target.files));
            fileInput.value = ''; // Reset input để có thể chọn lại file cùng tên
        }
    };

    function addFilesToStaging(newFiles) {
        let foundDups = [];
        newFiles.forEach(file => {
            // Kiểm tra trùng tên trong danh sách đang chọn
            if (!stagedFiles.some(item => item.file.name === file.name)) {
                const isPdf = file.name.toLowerCase().endsWith('.pdf');
                const hasCoverAlready = stagedFiles.some(item => item.isCover);

                stagedFiles.push({
                    id: Math.random().toString(36).substring(2, 9),
                    file: file,
                    sendToGemini: isPdf, // Mặc định PDF gửi AI
                    isCover: isPdf && !hasCoverAlready // Mặc định PDF đầu tiên làm ảnh bìa
                });

                // Kiểm tra trùng lặp với lịch sử văn bản đã lưu trong trình duyệt
                const dup = checkDuplicateDocument('', file.name);
                if (dup) {
                    foundDups.push({ file: file.name, dup });
                }
            }
        });

        if (duplicateAlert) {
            if (foundDups.length > 0) {
                duplicateAlert.style.display = 'block';
                duplicateAlert.innerHTML = `
                    <div style="font-weight: 700; color: #b45309; margin-bottom: 4px;">⚠️ PHÁT HIỆN ${foundDups.length} VĂN BẢN CÓ NGUY CƠ TRÙNG LẶP:</div>
                    <ul style="margin: 0; padding-left: 18px;">
                        ${foundDups.map(d => `
                            <li style="margin-bottom: 3px;">
                                Tệp <b>"${d.file}"</b> trùng với số hiệu/văn bản <b>"${d.dup.code || d.dup.fileName}"</b> 
                                (đã đăng ngày <i>${d.dup.publishedAt}</i>).
                            </li>
                        `).join('')}
                    </ul>
                `;
            } else {
                duplicateAlert.style.display = 'none';
            }
        }

        renderFileTable();
        logStatus(`Đã nạp ${stagedFiles.length} tệp. Hãy chọn tệp gửi AI và bấm "Bắt đầu"`, 'info');
    }

    function renderFileTable() {
        if (stagedFiles.length === 0) {
            fileTableContainer.style.display = 'none';
            return;
        }
        fileTableContainer.style.display = 'block';
        fileCountSpan.textContent = stagedFiles.length;
        fileTableBody.innerHTML = '';

        stagedFiles.forEach(item => {
            const tr = document.createElement('tr');
            const isPdf = item.file.name.toLowerCase().endsWith('.pdf');
            const sizeKb = (item.file.size / 1024).toFixed(1);

            tr.innerHTML = `
                <td>
                    <div style="font-weight: 500; display: flex; align-items: center; gap: 6px;">
                        <span>${isPdf ? '📄' : '📎'}</span>
                        <span>${item.file.name}</span>
                    </div>
                    <div style="font-size: 11px; color: #64748b; margin-left: 22px;">${sizeKb} KB</div>
                </td>
                <td style="text-align: center;">
                    <input type="checkbox" class="da-chk-gemini" data-id="${item.id}" ${item.sendToGemini ? 'checked' : ''} style="cursor: pointer; width: 16px; height: 16px;" />
                </td>
                <td style="text-align: center;">
                    <input type="radio" name="da-cover-radio" class="da-rad-cover" data-id="${item.id}" ${item.isCover ? 'checked' : ''} style="cursor: pointer; width: 16px; height: 16px;" />
                </td>
                <td style="text-align: center;">
                    <button class="da-btn da-btn-danger da-btn-del" data-id="${item.id}" title="Bỏ tệp này">&times;</button>
                </td>
            `;
            fileTableBody.appendChild(tr);
        });

        // Gắn sự kiện thay đổi
        document.querySelectorAll('.da-chk-gemini').forEach(chk => {
            chk.onchange = (e) => {
                const id = e.target.getAttribute('data-id');
                const target = stagedFiles.find(f => f.id === id);
                if (target) target.sendToGemini = e.target.checked;
            };
        });

        document.querySelectorAll('.da-rad-cover').forEach(rad => {
            rad.onchange = (e) => {
                const id = e.target.getAttribute('data-id');
                stagedFiles.forEach(f => f.isCover = (f.id === id));
            };
        });

        document.querySelectorAll('.da-btn-del').forEach(btn => {
            btn.onclick = (e) => {
                const id = e.target.getAttribute('data-id');
                stagedFiles = stagedFiles.filter(f => f.id !== id);
                if (stagedFiles.length > 0 && !stagedFiles.some(f => f.isCover)) {
                    const firstPdf = stagedFiles.find(f => f.file.name.toLowerCase().endsWith('.pdf'));
                    if (firstPdf) firstPdf.isCover = true;
                }
                renderFileTable();
            };
        });
    }

    // ==========================================
    // 5. AUTH HEADERS & MEDIA API (ĐỒNG BỘ HEADERS & UPLOAD LÊN IGOVMEDIA)
    // ==========================================
    function getCmsAuthHeaders() {
        const headers = {
            'unitcode': liveCmsHeaders['unitcode'] || 'LDG',
            'deviceid': liveCmsHeaders['deviceid'] || 'Web;Chrome;cd3a6920-b9fc-4380-9f62-98b07f462b00'
        };
        if (liveCmsHeaders['currentpublicip']) {
            headers['currentpublicip'] = liveCmsHeaders['currentpublicip'];
        }
        if (liveCmsHeaders['authorization'] || liveCmsHeaders['Authorization']) {
            headers['Authorization'] = liveCmsHeaders['authorization'] || liveCmsHeaders['Authorization'];
        }

        // 1. Quét thêm localStorage nếu chưa có
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                const v = localStorage.getItem(k);
                if (k.toLowerCase().includes('device') && !liveCmsHeaders['deviceid']) headers['deviceid'] = v.replace(/^"|"$/g, '');
                if (k.toLowerCase().includes('unit') && !liveCmsHeaders['unitcode']) headers['unitcode'] = v.replace(/^"|"$/g, '');
                if ((k.toLowerCase().includes('token') || k.toLowerCase().includes('auth')) && !headers['Authorization']) {
                    headers['Authorization'] = v.replace(/^"|"$/g, '');
                }
            }
        } catch (e) {}

        // 2. Quét sessionStorage
        try {
            for (let i = 0; i < sessionStorage.length; i++) {
                const k = sessionStorage.key(i);
                const v = sessionStorage.getItem(k);
                if (!headers['deviceid'] && k.toLowerCase().includes('device')) headers['deviceid'] = v.replace(/^"|"$/g, '');
                if (!headers['Authorization'] && (k.toLowerCase().includes('token') || k.toLowerCase().includes('auth'))) {
                    headers['Authorization'] = v.replace(/^"|"$/g, '');
                }
            }
        } catch (e) {}

        // 3. Quét AngularJS $http defaults
        if (window.angular) {
            try {
                const injector = window.angular.element(document.body).injector() || window.angular.element(document.querySelector('.modal, form, [ng-app]') || document.body).injector();
                if (injector && injector.has('$http')) {
                    const http = injector.get('$http');
                    const common = http.defaults.headers.common || {};
                    if (common['deviceid']) headers['deviceid'] = common['deviceid'];
                    if (common['unitcode']) headers['unitcode'] = common['unitcode'];
                    if (common['currentpublicip']) headers['currentpublicip'] = common['currentpublicip'];
                    if (common['Authorization'] || common['authorization']) headers['Authorization'] = common['Authorization'] || common['authorization'];
                }
            } catch (e) {}
        }

        if (headers['Authorization'] && !headers['Authorization'].startsWith('Bearer ')) {
            headers['Authorization'] = `Bearer ${headers['Authorization']}`;
        }
        return headers;
    }

    function formatDateFolder(d) {
        if (!d || isNaN(d.getTime())) return getTodayFormatted();
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yyyy = d.getFullYear();
        return `${dd}-${mm}-${yyyy}`;
    }

    async function getOrCreateFolderByDate(customDateStr) {
        const folderName = customDateStr || getTodayFormatted();
        const origin = window.location.origin;
        const authHeaders = getCmsAuthHeaders();

        try {
            // 1. Lấy danh sách thư mục
            const folderRes = await new Promise((resolve) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', `${origin}/api/media/FoldersByUser`);
                xhr.setRequestHeader('Content-Type', 'application/json');
                for (const h in authHeaders) xhr.setRequestHeader(h, authHeaders[h]);
                xhr.withCredentials = true;

                xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        try { resolve(JSON.parse(xhr.responseText)); } catch (e) { resolve(null); }
                    } else resolve(null);
                };
                xhr.onerror = () => resolve(null);
                xhr.send('{}');
            });

            let rootId = 'a485360c-1319-4115-9701-8ae0cf7641d7';
            if (folderRes && folderRes.Result && folderRes.Result.length > 0) {
                const root = folderRes.Result.find(f => f.Name === 'Root') || folderRes.Result[0];
                rootId = root.Id;

                // Kiểm tra thư mục ngày theo ngày đăng đã có chưa
                const existingFolder = (root.ChildrenFolders || []).find(f => f.Name === folderName);
                if (existingFolder) {
                    return existingFolder.Id;
                }
            }

            // 2. Tạo thư mục ngày mới nếu chưa có
            const createRes = await new Promise((resolve) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', `${origin}/api/media/AddFolder`);
                xhr.setRequestHeader('Content-Type', 'application/json');
                for (const h in authHeaders) xhr.setRequestHeader(h, authHeaders[h]);
                xhr.withCredentials = true;

                xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        try { resolve(JSON.parse(xhr.responseText)); } catch (e) { resolve(null); }
                    } else resolve(null);
                };
                xhr.onerror = () => resolve(null);
                xhr.send(JSON.stringify({ Name: folderName, ParentId: rootId }));
            });

            if (createRes && createRes.Result) {
                return typeof createRes.Result === 'string' ? createRes.Result : createRes.Result.Id;
            }
        } catch (e) {
            console.warn('Lỗi kiểm tra/tạo thư mục ngày:', e);
        }
        return null;
    }

    // Alias tương thích ngược
    const getOrCreateTodayFolder = getOrCreateFolderByDate;

    async function uploadFileToLamDongMedia(fileOrBlob, filename, folderId) {
        const origin = window.location.origin;
        const isImage = filename.toLowerCase().match(/\.(jpg|jpeg|png|gif|webp|bmp)$/);
        const authHeaders = getCmsAuthHeaders();
        
        const formData = new FormData();
        formData.append('Files[]', fileOrBlob, filename);
        if (folderId) {
            formData.append('FolderId', folderId);
        }
        formData.append('FileType', isImage ? 'image' : 'file');
        formData.append('HasThumb', 'true');

        return new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${origin}/api/media/UploadFile`);
            for (const h in authHeaders) xhr.setRequestHeader(h, authHeaders[h]);
            xhr.withCredentials = true;

            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const res = JSON.parse(xhr.responseText);
                        const domain = res.Domain || 'https://igovmedia.lamdongtructuyen.vn/';
                        const baseDomain = domain.endsWith('/') ? domain.slice(0, -1) : domain;

                        if (res.Result) {
                            const item = Array.isArray(res.Result) ? res.Result[0] : (res.Result.Files ? res.Result.Files[0] : res.Result);
                            if (item && item.Url) {
                                const fullUrl = item.Url.startsWith('http') ? item.Url : `${baseDomain}${item.Url}`;
                                resolve({
                                    id: item.Id,
                                    name: item.Name || filename,
                                    url: item.Url,
                                    thumbUrl: item.ThumbUrl,
                                    fullUrl: fullUrl
                                });
                                return;
                            }
                        }
                        resolve(null);
                    } catch (e) {
                        resolve(null);
                    }
                } else {
                    console.warn('UploadFile HTTP Error:', xhr.status, xhr.responseText);
                    resolve(null);
                }
            };
            xhr.onerror = () => resolve(null);
            xhr.send(formData);
        });
    }

    // ==========================================
    // 6. TỰ ĐỘNG MỞ FORM "+ THÊM MỚI" NẾU CHƯA MỞ
    // ==========================================
    async function ensureCreateFormIsOpen() {
        if (isArticleFormCurrentlyOpen()) {
            logStatus('Đã phát hiện Form bài viết đang mở sẵn. Sẽ điền trực tiếp vào Form này!', 'info');
            return true;
        }

        logStatus('Form chưa mở. Đang tự động nhấn "+ Thêm mới"...', 'info');
        const candidateBtns = Array.from(document.querySelectorAll('button, a, .btn, [role="button"]'));
        const addBtn = candidateBtns.find(b => {
            if (b.closest('#da-modal, .da-auto-wrapper')) return false;
            const text = (b.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
            const title = (b.getAttribute('title') || '').toLowerCase();
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            const isMatch = text.includes('thêm mới') || title.includes('thêm mới') || aria.includes('thêm mới') || normalizeVn(text).includes('them moi');
            return isMatch && isElementVisible(b);
        });

        if (addBtn) {
            addBtn.click();
            logStatus('Đã nhấn "+ Thêm mới", đang chờ mở Form...', 'info');
            for (let t = 0; t < 15; t++) {
                await new Promise(r => setTimeout(r, 200));
                if (isArticleFormCurrentlyOpen()) {
                    logStatus('Form "Thêm mới tin tức" đã mở thành công!', 'success');
                    autoSelectArticleType();
                    return true;
                }
            }
        }
        return false;
    }

    // ==========================================
    // 7. XỬ LÝ CHÍNH KHI NHẤN NÚT BẮT ĐẦU
    // ==========================================
    startProcessBtn.onclick = async () => {
        if (stagedFiles.length === 0) {
            logStatus('Chưa có tệp nào được chọn. Vui lòng kéo thả file vào khung!', 'error');
            return;
        }

        startProcessBtn.disabled = true;
        startProcessBtn.textContent = '⏳ Đang xử lý & Upload...';

        try {
            // 1. Mở form Thêm mới nếu chưa mở
            await ensureCreateFormIsOpen();

            // 2. Xử lý Ảnh bìa Trang 1
            let coverItem = stagedFiles.find(f => f.isCover);
            if (!coverItem) coverItem = stagedFiles.find(f => f.file.name.toLowerCase().endsWith('.pdf')) || stagedFiles[0];

            coverImageBlob = null;
            coverFileName = coverItem.file.name.replace(/\.[^/.]+$/, "") + "_cover.jpg";

            if (coverItem.file.name.toLowerCase().endsWith('.pdf')) {
                logStatus(`Đang render Trang 1 của "${coverItem.file.name}" làm ảnh bìa...`, 'info');
                const pdfData = await coverItem.file.arrayBuffer();
                const loadingTask = window.pdfjsLib.getDocument({ data: pdfData });
                const pdfDoc = await loadingTask.promise;

                const coverConfig = getCoverQualityConfig();
                const page1 = await pdfDoc.getPage(1);
                const scale = coverConfig.scale;
                const viewport = page1.getViewport({ scale });

                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                canvas.width = viewport.width;
                canvas.height = viewport.height;

                await page1.render({ canvasContext: context, viewport }).promise;
                coverImageBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', coverConfig.quality));

                coverPreview.src = URL.createObjectURL(coverImageBlob);
                previewInfo.textContent = `Tệp: ${coverItem.file.name} (${(coverImageBlob.size / 1024).toFixed(1)} KB)`;
                previewArea.style.display = 'flex';
                logStatus(`Tạo ảnh bìa trang 1 thành công (${(coverImageBlob.size / 1024).toFixed(1)} KB - ${coverConfig.label})!`, 'success');
            } else if (coverItem.file.type.startsWith('image/')) {
                coverImageBlob = coverItem.file;
                coverPreview.src = URL.createObjectURL(coverImageBlob);
                previewArea.style.display = 'flex';
            }

            // 3. Trích xuất text gửi cho AI
            const geminiFiles = stagedFiles.filter(f => f.sendToGemini);
            if (geminiFiles.length === 0) {
                logStatus('Không có file nào được chọn để gửi cho AI! Hãy tích chọn "🤖 Gửi Gemini".', 'error');
                startProcessBtn.disabled = false;
                startProcessBtn.textContent = '🚀 Bắt đầu Phân tích AI & Điền vào Form';
                return;
            }

            let combinedExtractedText = '';
            for (const item of geminiFiles) {
                if (item.file.name.toLowerCase().endsWith('.pdf')) {
                    logStatus(`Đang trích xuất toàn bộ chữ từ: "${item.file.name}"...`, 'info');
                    const pdfData = await item.file.arrayBuffer();
                    const loadingTask = window.pdfjsLib.getDocument({ data: pdfData });
                    const pdfDoc = await loadingTask.promise;

                    combinedExtractedText += `\n\n=== TỆP TIN: ${item.file.name} (${pdfDoc.numPages} trang) ===\n`;
                    for (let p = 1; p <= pdfDoc.numPages; p++) {
                        const page = await pdfDoc.getPage(p);
                        const textContent = await page.getTextContent();
                        const pageText = textContent.items.map(it => it.str).join(' ');
                        combinedExtractedText += `\n--- Trang ${p} ---\n` + pageText;
                    }
                } else {
                    combinedExtractedText += `\n\n=== TỆP PHỤ LỤC: ${item.file.name} ===\n`;
                }
            }

            let base64CoverImage = null;
            if (coverImageBlob) {
                base64CoverImage = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result ? reader.result.split(',')[1] : null);
                    reader.readAsDataURL(coverImageBlob);
                });
            }

            // 4. Gọi Gemini AI với kho Multi-Key & Multi-Model Fallback
            const apiKeys = getApiKeyList();
            if (apiKeys.length === 0) {
                logStatus('Chưa có Gemini API Key! Bấm vào tab "⚙ Cấu hình AI" để nhập ít nhất 1 Key.', 'error');
                switchTab('settings');
                startProcessBtn.disabled = false;
                startProcessBtn.textContent = '🚀 Bắt đầu Phân tích AI & Điền vào Form';
                return;
            }
            logStatus(`Đang gửi dữ liệu phân tích tới Gemini AI (${apiKeys.length} key trong kho dự phòng)...`, 'info');

            const aiResult = await callGeminiAIWithRoutePrompt(combinedExtractedText, geminiFiles[0].file.name, base64CoverImage, apiKeys);
            logStatus('Gemini AI đã phân tích và sinh nội dung hoàn tất!', 'success');

            // 5. TÍNH TOÁN NGÀY ĐĂNG & TẠO THƯ MỤC LƯU TRỮ THEO ĐÚNG NGÀY ĐĂNG
            const finalTitle = (aiResult && aiResult.title && aiResult.title.trim()) ? aiResult.title.trim() : (geminiFiles[0]?.file?.name?.replace(/\.[^/.]+$/, "") || '');
            const cleanDocCode = (aiResult && aiResult.documentCode ? aiResult.documentCode : '').replace(/\s*\/\s*/g, '/').trim();
            const pubDateResult = computePublishDate(
                aiResult.documentDate,
                combinedExtractedText,
                geminiFiles[0]?.file?.name || '',
                finalTitle,
                cleanDocCode,
                aiResult.issuerLevel
            );

            // Thư mục lưu trữ trên Media Lâm Đồng theo đúng Ngày đăng
            const targetFolderDateStr = formatDateFolder(pubDateResult.dateObj);
            const folderBadge = document.getElementById('da-current-folder-badge');
            if (folderBadge) folderBadge.textContent = targetFolderDateStr;
            logStatus(`Đang đồng bộ thư mục theo ngày đăng "${targetFolderDateStr}" trên máy chủ Media...`, 'info');
            const targetFolderId = await getOrCreateFolderByDate(targetFolderDateStr);

            // 6. UPLOAD THỰC TẾ LÊN MÁY CHỦ MEDIA LÂM ĐỒNG VÀO THƯ MỤC NGÀY ĐĂNG
            logStatus(`Đang tải các tệp tin và ảnh bìa vào thư mục "${targetFolderDateStr}"...`, 'info');
            
            // Upload ảnh bìa
            let uploadedCover = null;
            if (coverImageBlob) {
                uploadedCover = await uploadFileToLamDongMedia(coverImageBlob, coverFileName, targetFolderId);
                if (uploadedCover) {
                    logStatus(`Đã tải ảnh bìa lên thư mục ${targetFolderDateStr}: ${uploadedCover.fullUrl}`, 'success');
                }
            }

            // Upload toàn bộ các file đính kèm
            const uploadedAttachments = [];
            for (const item of stagedFiles) {
                logStatus(`Đang tải file lên máy chủ: "${item.file.name}"...`, 'info');
                const uploadRes = await uploadFileToLamDongMedia(item.file, item.file.name, targetFolderId);
                if (uploadRes) {
                    uploadedAttachments.push(uploadRes);
                    logStatus(`✔ Tải thành công: ${item.file.name}`, 'success');
                } else {
                    // Fallback link tương đối vào đúng thư mục ngày đăng
                    uploadedAttachments.push({
                        name: item.file.name,
                        fullUrl: `/uploads/${targetFolderDateStr}/${encodeURIComponent(item.file.name)}`
                    });
                }
            }

            // 7. ĐIỀN DỮ LIỆU VÀO FORM CMS
            logStatus('Đang điền Tiêu đề, Loại bài viết, Ngày đăng, Ảnh đại diện, Nội dung và File đính kèm vào Form...', 'info');

            // Tự động kiểm tra và chọn Loại bài viết
            await autoSelectArticleType();

            // Tiêu đề
            setTitleAndTriggerAlias(finalTitle);

            // Ngày đăng
            setPublishDateToForm(pubDateResult);

            // Khối tài liệu đính kèm với link thật thuộc đúng thư mục ngày đăng
            let fullContentHtml = aiResult.contentHtml;
            let attachmentsHtml = `
                <p>&nbsp;</p>
                <div style="margin-top: 25px; padding: 15px 18px; background-color: #f8fafc; border: 1px solid #cbd5e1; border-left: 4px solid #0078d4; border-radius: 6px;">
                    <div style="font-weight: 700; color: #0078d4; font-size: 14px; margin-bottom: 10px; text-transform: uppercase;">
                        📁 Tài liệu đính kèm:
                    </div>
                    <ul style="margin: 0; padding-left: 20px; font-size: 13.5px; line-height: 1.8;">
                        ${uploadedAttachments.map(item => `
                            <li>
                                <a href="${item.fullUrl}" target="_blank" style="color: #0284c7; font-weight: 600; text-decoration: underline;">
                                    ${item.name.toLowerCase().endsWith('.pdf') ? '📄' : '📎'} ${item.name}
                                </a>
                            </li>
                        `).join('')}
                    </ul>
                </div>
            `;
            fullContentHtml += attachmentsHtml;

            // Nạp CKEditor
            setEditorContent(fullContentHtml);

            // Nạp Ảnh đại diện thật vào Form
            const finalAvatarUrl = uploadedCover ? (uploadedCover.url || uploadedCover.fullUrl) : (coverImageBlob ? URL.createObjectURL(coverImageBlob) : '');
            const finalAvatarFullUrl = uploadedCover ? uploadedCover.fullUrl : finalAvatarUrl;
            handleAvatarImageInjection(coverImageBlob, finalAvatarUrl, finalAvatarFullUrl);

            // Ghi nhận số hiệu và bài viết vào lịch sử trình duyệt để kiểm tra trùng lặp các lần sau
            recordPublishedDocument(cleanDocCode, finalTitle, geminiFiles[0].file.name);

            logStatus(`🎉 ĐÃ HOÀN TẤT! Toàn bộ file đã lưu vào thư mục "${targetFolderDateStr}" và điền xong dữ liệu vào Form.`, 'success');

            setTimeout(() => {
                hideModal();
            }, 1200);

        } catch (err) {
            console.error('Lỗi quy trình:', err);
            logStatus('Lỗi: ' + err.message, 'error');
        } finally {
            startProcessBtn.disabled = false;
            startProcessBtn.textContent = '🚀 Bắt đầu Phân tích AI & Điền vào Form';
        }
    };

    // ==========================================
    // 7. GỌI GEMINI VỚI PROMPT THEO URL
    // ==========================================
    async function callGeminiAIWithRoutePrompt(extractedText, filename, base64CoverImage, apiKeys) {
        let templatePrompt = getPromptForCurrentUrl();
        templatePrompt = templatePrompt
            .replace('{filename}', filename)
            .replace('{extractedText}', extractedText || 'Văn bản dạng hình ảnh scan.');

        const parts = [{ text: templatePrompt }];

        if (base64CoverImage) {
            parts.push({
                inlineData: {
                    mimeType: "image/jpeg",
                    data: base64CoverImage
                }
            });
        }

        let userSelectedModel = GM_getValue('GEMINI_MODEL', 'gemini-3.6-flash');
        if (!userSelectedModel || userSelectedModel === 'gemini-2.0-flash') userSelectedModel = 'gemini-3.6-flash';

        // Chuỗi Fallback Model: nếu model đầu tiên gặp lỗi sẽ tự động chuyển sang model kế tiếp
        const candidateModels = [userSelectedModel, 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-1.5-flash'];
        const uniqueModels = Array.from(new Set(candidateModels));

        const keysPool = Array.isArray(apiKeys) && apiKeys.length > 0 ? apiKeys : getApiKeyList();
        if (keysPool.length === 0) {
            throw new Error('Chưa có Gemini API Key! Vui lòng nhập ít nhất 1 Key vào tab "⚙ Cấu hình AI".');
        }

        let lastError = null;

        // Ma trận Xoay Vòng: Duyệt qua từng Key trong Kho -> Thử qua từng Model
        for (let kIdx = 0; kIdx < keysPool.length; kIdx++) {
            const currentApiKey = keysPool[kIdx];
            const keyDisplay = `Key #${kIdx + 1} (...${currentApiKey.slice(-4)})`;

            for (const model of uniqueModels) {
                try {
                    const res = await new Promise((resolve, reject) => {
                        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentApiKey}`;
                        GM_xmlhttpRequest({
                            method: 'POST',
                            url: url,
                            headers: { 'Content-Type': 'application/json' },
                            data: JSON.stringify({
                                contents: [{ parts: parts }],
                                generationConfig: {
                                    temperature: 0.2,
                                    responseMimeType: "application/json",
                                    responseSchema: {
                                        type: "OBJECT",
                                        properties: {
                                            documentCode: { type: "STRING" },
                                            documentDate: { type: "STRING" },
                                            issuerLevel: { type: "STRING" },
                                            title: { type: "STRING" },
                                            contentHtml: { type: "STRING" }
                                        },
                                        required: ["title", "contentHtml"]
                                    }
                                }
                            }),
                            onload: function (response) {
                                if (response.status >= 200 && response.status < 300) {
                                    try {
                                        const resJson = JSON.parse(response.responseText);
                                        const text = resJson.candidates[0].content.parts[0].text;
                                        
                                        // 1. Thử parse trực tiếp
                                        try {
                                            const parsed = JSON.parse(text);
                                            if (parsed && (parsed.title || parsed.Title)) {
                                                resolve({
                                                    documentCode: parsed.documentCode || parsed.DocumentCode || '',
                                                    documentDate: parsed.documentDate || parsed.DocumentDate || '',
                                                    issuerLevel: parsed.issuerLevel || parsed.IssuerLevel || '',
                                                    title: parsed.title || parsed.Title || '',
                                                    contentHtml: parsed.contentHtml || parsed.ContentHtml || parsed.content || ''
                                                });
                                                return;
                                            }
                                        } catch (e) {}

                                        // 2. Xử lý làm sạch chuỗi JSON
                                        let cleanText = text.replace(/```json/gi, '').replace(/```/g, '').trim();
                                        const firstBrace = cleanText.indexOf('{');
                                        const lastBrace = cleanText.lastIndexOf('}');
                                        if (firstBrace !== -1 && lastBrace !== -1) {
                                            cleanText = cleanText.substring(firstBrace, lastBrace + 1);
                                        }

                                        try {
                                            const parsed = JSON.parse(cleanText);
                                            if (parsed && (parsed.title || parsed.Title)) {
                                                resolve({
                                                    documentCode: parsed.documentCode || parsed.DocumentCode || '',
                                                    documentDate: parsed.documentDate || parsed.DocumentDate || '',
                                                    issuerLevel: parsed.issuerLevel || parsed.IssuerLevel || '',
                                                    title: parsed.title || parsed.Title || '',
                                                    contentHtml: parsed.contentHtml || parsed.ContentHtml || parsed.content || ''
                                                });
                                                return;
                                            }
                                        } catch (e) {}

                                        // 3. Fallback: Dùng Regex trích xuất độc lập title và contentHtml
                                        const titleMatch = cleanText.match(/"(?:title|Title)"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
                                        const codeMatch = cleanText.match(/"(?:documentCode|DocumentCode)"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
                                        const dateMatch = cleanText.match(/"(?:documentDate|DocumentDate)"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
                                        const issuerMatch = cleanText.match(/"(?:issuerLevel|IssuerLevel)"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
                                        let contentMatch = cleanText.match(/"(?:contentHtml|ContentHtml|content)"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
                                        
                                        if (!contentMatch) {
                                            const contentStart = cleanText.indexOf('"contentHtml"') !== -1 ? cleanText.indexOf('"contentHtml"') : cleanText.indexOf('"content"');
                                            if (contentStart !== -1) {
                                                const valStart = cleanText.indexOf('"', contentStart + 13) + 1;
                                                const valEnd = cleanText.lastIndexOf('"');
                                                if (valStart > 0 && valEnd > valStart) {
                                                    contentMatch = [null, cleanText.substring(valStart, valEnd)];
                                                }
                                            }
                                        }

                                        if (titleMatch && titleMatch[1]) {
                                            const unescapedTitle = titleMatch[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\\\/g, '\\');
                                            const unescapedCode = codeMatch ? codeMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : '';
                                            const unescapedDate = dateMatch ? dateMatch[1].replace(/\\"/g, '"').trim() : '';
                                            const unescapedIssuer = issuerMatch ? issuerMatch[1].replace(/\\"/g, '"').trim() : '';
                                            const unescapedContent = contentMatch ? contentMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\') : '';
                                            resolve({
                                                documentCode: unescapedCode,
                                                documentDate: unescapedDate,
                                                issuerLevel: unescapedIssuer,
                                                title: unescapedTitle,
                                                contentHtml: unescapedContent
                                            });
                                            return;
                                        }

                                        reject(new Error('Không thể bóc tách Tiêu đề & Nội dung từ AI.'));
                                    } catch (e) {
                                        reject(new Error('Lỗi parse kết quả Gemini: ' + e.message));
                                    }
                                } else {
                                    reject(new Error(`Lỗi Gemini API (${response.status}) [${keyDisplay} - ${model}]: ${response.responseText}`));
                                }
                            },
                            onerror: function (err) {
                                reject(new Error(`Lỗi kết nối mạng tới Gemini API [${keyDisplay}]`));
                            }
                        });
                    });

                    // Thành công trả về kết quả ngay
                    return res;
                } catch (err) {
                    console.warn(`Thử [${keyDisplay} - ${model}] thất bại:`, err.message);
                    lastError = err;
                    // Nếu lỗi do 429 Quota hoặc 403 Forbidden của Key này -> chuyển sang Key tiếp theo trong kho
                    if (err.message.includes('429') || err.message.includes('403') || err.message.includes('RESOURCE_EXHAUSTED')) {
                        logStatus(`⚠️ ${keyDisplay} hết quota (429), đang tự động chuyển sang Key tiếp theo...`, 'info');
                        break; // Thoát vòng lặp model để thử Key kế tiếp
                    }
                }
            }
        }

        throw lastError || new Error('Tất cả các API Key và Model Gemini trong kho đều không phản hồi.');
    }

    // ==========================================
    // 8. HELPERS ĐIỀN FORM VÀ EDITOR
    // ==========================================
    /**
     * Helper dùng chung: Đồng bộ giá trị vào Angular Ivy (Angular 2 - 19+)
     * Tự động quét component, FormControl và kích hoạt Change Detection
     */
    function syncToAngularIvy(nodeOrSelector, updater) {
        const realNg = pageWin.ng || window.ng;
        if (!realNg) return;
        try {
            const nodes = typeof nodeOrSelector === 'string'
                ? Array.from(document.querySelectorAll(nodeOrSelector))
                : (nodeOrSelector instanceof NodeList || Array.isArray(nodeOrSelector) ? Array.from(nodeOrSelector) : [nodeOrSelector]);

            nodes.forEach(node => {
                if (!node || (node.closest && node.closest('#da-modal, .da-auto-wrapper'))) return;
                try {
                    const comp = (realNg.getComponent && realNg.getComponent(node)) ||
                                 (realNg.getOwningComponent && realNg.getOwningComponent(node)) ||
                                 (realNg.getContext && realNg.getContext(node));
                    if (comp) {
                        const changed = updater(comp, realNg);
                        if (changed) {
                            if (comp.cd) {
                                if (comp.cd.detectChanges) comp.cd.detectChanges();
                                if (comp.cd.markForCheck) comp.cd.markForCheck();
                            }
                            if (comp.cdr) {
                                if (comp.cdr.detectChanges) comp.cdr.detectChanges();
                                if (comp.cdr.markForCheck) comp.cdr.markForCheck();
                            }
                            if (realNg.applyChanges) realNg.applyChanges(comp);
                        }
                    }
                } catch (e) {}
            });
        } catch (e) {}
    }

    /**
     * Helper dùng chung: Đồng bộ giá trị vào AngularJS Scope (1.x)
     */
    function syncToAngularJs(nodeOrSelector, updater) {
        const realAngular = pageWin.angular || window.angular;
        if (!realAngular) return;
        try {
            const nodes = typeof nodeOrSelector === 'string'
                ? Array.from(document.querySelectorAll(nodeOrSelector))
                : (nodeOrSelector instanceof NodeList || Array.isArray(nodeOrSelector) ? Array.from(nodeOrSelector) : [nodeOrSelector]);

            nodes.forEach(el => {
                if (!el || (el.closest && el.closest('#da-modal, .da-auto-wrapper'))) return;
                try {
                    const scope = realAngular.element(el).scope();
                    if (scope) {
                        const changed = updater(scope);
                        if (changed !== false) {
                            try { scope.$applyAsync(); } catch (e) {}
                        }
                    }
                } catch (e) {}
            });
        } catch (e) {}
    }

    function setNativeInputValue(element, value) {
        if (!element) return;
        try {
            element.value = value;
        } catch (e) {}
        try {
            const proto = Object.getPrototypeOf(element);
            const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (valueSetter) {
                valueSetter.call(element, value);
            }
        } catch (e) {}

        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' }));
        element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
        element.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    function setTitleAndTriggerAlias(titleText) {
        if (!titleText) return;
        currentArticleTitleText = titleText; // Lưu tiêu đề để tự động tiêm vào request khi bấm Lưu thay đổi

        const applyTitleToForm = () => {
            const matchedInputs = new Set();

            // Cách 1: Tìm theo Placeholder "Tiêu đề" / "Title"
            document.querySelectorAll('input, textarea').forEach(inp => {
                if (inp.closest('#da-modal, .da-auto-wrapper')) return;
                const p = (inp.getAttribute('placeholder') || '').toLowerCase();
                if (p.includes('tiêu đề') || p.includes('title')) {
                    matchedInputs.add(inp);
                }
            });

            // Cách 2: Tìm theo Thuộc tính (name, id, formcontrolname, ng-model)
            document.querySelectorAll('input[formcontrolname*="title" i], input[formcontrolname*="name" i], input[name*="title" i], input[id*="title" i], input[id*="tieude" i], input[ng-model*="Title"], input[ng-model*="title"]').forEach(inp => {
                if (!inp.closest('#da-modal, .da-auto-wrapper')) matchedInputs.add(inp);
            });

            // Cách 3: Tìm qua thẻ <label> chứa chữ "Tiêu đề"
            document.querySelectorAll('label, span, div, b, strong').forEach(lbl => {
                if (lbl.closest('#da-modal, .da-auto-wrapper')) return;
                const txt = lbl.textContent.trim().toLowerCase();
                if (txt.startsWith('tiêu đề') || txt === 'tiêu đề (*)' || txt === 'tiêu đề' || txt === 'title (*)') {
                    const container = lbl.closest('.form-group, .form-item, .row, div') || lbl.parentElement;
                    if (container) {
                        const inp = container.querySelector('input[type="text"], input:not([type]), textarea');
                        if (inp && !inp.closest('#da-modal, .da-auto-wrapper')) matchedInputs.add(inp);
                    }
                }
            });

            // Cách 4: Lấy ô input text nằm ngay phía trên CKEditor
            if (matchedInputs.size === 0) {
                const cke = document.querySelector('.cke, ckeditor, #cke_Content, #cke_content');
                if (cke) {
                    const allInputsBefore = Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).filter(inp => {
                        return !inp.closest('#da-modal, .da-auto-wrapper') && (inp.compareDocumentPosition(cke) & Node.DOCUMENT_POSITION_FOLLOWING);
                    });
                    if (allInputsBefore.length > 0) {
                        matchedInputs.add(allInputsBefore[allInputsBefore.length - 1]);
                    }
                }
            }

            matchedInputs.forEach(inp => {
                setNativeInputValue(inp, titleText);

                // Đồng bộ Angular Ivy (Angular 2 - 19+)
                syncToAngularIvy(inp, comp => {
                    if ('Title' in comp) comp.Title = titleText;
                    if ('title' in comp) comp.title = titleText;
                    if (comp.item) comp.item.Title = titleText;
                    if (comp.model) comp.model.Title = titleText;
                    if (comp.form && comp.form.controls) {
                        const ctrl = comp.form.controls.Title || comp.form.controls.title || comp.form.controls.Name || comp.form.controls.name;
                        if (ctrl) {
                            ctrl.setValue(titleText);
                            if (ctrl.markAsDirty) ctrl.markAsDirty();
                            if (ctrl.markAsTouched) ctrl.markAsTouched();
                            if (ctrl.updateValueAndValidity) ctrl.updateValueAndValidity();
                            return true;
                        }
                    }
                    return true;
                });

                // Đồng bộ AngularJS Scope (1.x)
                syncToAngularJs(inp, scope => {
                    if (scope.model) scope.model.Title = titleText;
                    if (scope.item) scope.item.Title = titleText;
                });
            });
        };

        const applyAliasToForm = () => {
            const slug = generateSlug(titleText);
            if (!slug) return;
            const aliasInputs = new Set();
            document.querySelectorAll('input[formcontrolname*="alias" i], input[name*="alias" i], input[id*="alias" i], input[placeholder*="alias" i], input[placeholder*="đường dẫn" i], input[placeholder*="slug" i]').forEach(inp => {
                if (!inp.closest('#da-modal, .da-auto-wrapper')) aliasInputs.add(inp);
            });

            aliasInputs.forEach(inp => {
                if (!inp.value || inp.value.trim() === '') {
                    setNativeInputValue(inp, slug);
                    syncToAngularIvy(inp, comp => {
                        if ('Alias' in comp) comp.Alias = slug;
                        if ('alias' in comp) comp.alias = slug;
                        if (comp.item) comp.item.Alias = slug;
                        if (comp.model) comp.model.Alias = slug;
                        if (comp.form && comp.form.controls) {
                            const ctrl = comp.form.controls.Alias || comp.form.controls.alias;
                            if (ctrl) {
                                ctrl.setValue(slug);
                                if (ctrl.markAsDirty) ctrl.markAsDirty();
                                if (ctrl.markAsTouched) ctrl.markAsTouched();
                                if (ctrl.updateValueAndValidity) ctrl.updateValueAndValidity();
                                return true;
                            }
                        }
                        return true;
                    });
                    syncToAngularJs(inp, scope => {
                        if (scope.model) scope.model.Alias = slug;
                        if (scope.item) scope.item.Alias = slug;
                    });
                }
            });
        };

        applyTitleToForm();
        applyAliasToForm();
        setTimeout(() => { applyTitleToForm(); applyAliasToForm(); }, 300);
        setTimeout(() => { applyTitleToForm(); applyAliasToForm(); }, 800);
        setTimeout(() => { applyTitleToForm(); applyAliasToForm(); }, 1500);
    }

    function setEditorContent(html) {
        currentEditorContentHtml = html; // Lưu nội dung để tự động tiêm vào request khi bấm Lưu thay đổi

        const populateAllEditors = () => {
            // 1. Đồng bộ qua CKEDITOR API toàn cục trên Page Context
            const realCKEDITOR = pageWin.CKEDITOR || window.CKEDITOR;
            let hasCkInstance = false;
            if (realCKEDITOR && realCKEDITOR.instances) {
                for (const key in realCKEDITOR.instances) {
                    const inst = realCKEDITOR.instances[key];
                    if (inst) {
                        hasCkInstance = true;
                        try {
                            const doSet = () => {
                                try {
                                    inst.setData(html, function () {
                                        try { inst.fire('change'); } catch (e) {}
                                        try { inst.fire('dataReady'); } catch (e) {}
                                        try { inst.fire('saveSnapshot'); } catch (e) {}
                                        try { if (inst.updateElement) inst.updateElement(); } catch (e) {}
                                    });
                                } catch (e) {}
                            };
                            if (inst.status === 'ready') {
                                doSet();
                            } else if (inst.once) {
                                inst.once('instanceReady', doSet);
                            } else {
                                doSet();
                            }
                        } catch (e) {}
                    }
                }
            }

            // 2. Chỉ fallback vào iframe body của CKEditor nếu chưa có instance chính thức
            if (!hasCkInstance) {
                const ckeIframes = document.querySelectorAll('.cke_wysiwyg_frame');
                ckeIframes.forEach(ifr => {
                    try {
                        if (ifr.contentDocument && ifr.contentDocument.body) {
                            ifr.contentDocument.body.innerHTML = html;
                        }
                    } catch (e) {}
                });
            }

            // 3. Đồng bộ vào toàn bộ Textarea trên form
            const textareas = document.querySelectorAll('textarea');
            for (const ta of textareas) {
                ta.value = html;
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                ta.dispatchEvent(new Event('change', { bubbles: true }));
                ta.dispatchEvent(new Event('blur', { bubbles: true }));
            }
        };

        populateAllEditors();
        setTimeout(populateAllEditors, 300);
        setTimeout(populateAllEditors, 800);

        // 4. Đồng bộ vào Angular Ivy (Angular 2 - 19+) Form Controls & Validation
        syncToAngularIvy('form, .modal, ckeditor, [formcontrolname], textarea, input', comp => {
            let changed = false;
            ['Content', 'content', 'Description', 'description', 'Detail', 'detail'].forEach(key => {
                if (key in comp) { comp[key] = html; changed = true; }
                if (comp.item && key in comp.item) { comp.item[key] = html; changed = true; }
                if (comp.model && key in comp.model) { comp.model[key] = html; changed = true; }
                if (comp.form && comp.form.controls && comp.form.controls[key]) {
                    comp.form.controls[key].setValue(html);
                    comp.form.controls[key].markAsDirty();
                    comp.form.controls[key].markAsTouched();
                    comp.form.controls[key].updateValueAndValidity();
                    changed = true;
                }
            });
            if (comp.form) {
                comp.form.markAsDirty();
                comp.form.markAsTouched();
                comp.form.updateValueAndValidity();
            }
            return changed;
        });

        // 5. Đồng bộ AngularJS Scope (1.x)
        syncToAngularJs('.modal, form, [ng-controller], [ng-model*="Content"], [ng-model*="Description"], textarea, .modal-dialog, body', scope => {
            if (scope.model) { scope.model.Content = html; scope.model.Description = html; }
            if (scope.item) { scope.item.Content = html; scope.item.Description = html; }
        });

        // 6. Mở khóa nút "Lưu thay đổi" nếu bị Angular disable
        setTimeout(() => {
            const saveBtns = Array.from(document.querySelectorAll('button, a')).filter(b => b.textContent && b.textContent.includes('Lưu thay đổi'));
            saveBtns.forEach(btn => {
                btn.disabled = false;
                btn.removeAttribute('disabled');
                btn.classList.remove('disabled');
            });
        }, 300);
    }

    function handleAvatarImageInjection(blob, avatarUrl, avatarFullUrl) {
        const previewUrl = avatarFullUrl || (blob ? URL.createObjectURL(blob) : avatarUrl);
        const modelValue = avatarUrl || avatarFullUrl;
        currentUploadedAvatarUrl = modelValue; // Ghi nhớ URL để tự động tiêm vào request khi bấm Lưu thay đổi

        if (!previewUrl) return;

        const applyToPreviewElement = (el) => {
            if (!el || el.closest('#da-modal, .da-auto-wrapper, .cke, .cke_reset, ckeditor')) return;
            if (el.tagName === 'IMG') {
                el.src = previewUrl;
                el.srcset = '';
                el.style.display = 'block';
                el.style.objectFit = 'cover';
                el.style.width = '100%';
                el.style.height = '100%';
            } else {
                el.style.backgroundImage = `url("${previewUrl}")`;
                el.style.backgroundSize = 'cover';
                el.style.backgroundPosition = 'center';
                el.style.backgroundRepeat = 'no-repeat';
                // Đặt thẻ img bên trong để che hoàn toàn icon No Image available
                el.innerHTML = `<img src="${previewUrl}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 4px; display: block;" />`;
            }
        };

        const runDomAvatarSync = () => {
            // 1.1 Tìm nút "Chọn hình ảnh" và can thiệp khung ảnh bên cạnh
            const selectImgBtns = Array.from(document.querySelectorAll('button, a, .btn, div')).filter(b => {
                if (b.closest('#da-modal, .da-auto-wrapper')) return false;
                const t = (b.textContent || '').trim().toLowerCase();
                return t.includes('chọn hình') || t.includes('chọn ảnh');
            });

            selectImgBtns.forEach(btn => {
                const group = btn.closest('.form-group, .form-item, .row, [class*="col-"], div') || btn.parentElement;
                if (group) {
                    group.querySelectorAll('img').forEach(img => applyToPreviewElement(img));
                    group.querySelectorAll('div, figure, span').forEach(box => {
                        if (box === btn || box.contains(btn) || box.querySelector('button, a, label')) return;
                        const r = box.getBoundingClientRect();
                        if (r.width >= 40 && r.height >= 40 && r.width <= 300 && r.height <= 300) {
                            applyToPreviewElement(box);
                        }
                    });
                }
                if (btn.nextElementSibling) applyToPreviewElement(btn.nextElementSibling);
                if (btn.previousElementSibling) applyToPreviewElement(btn.previousElementSibling);
                if (btn.parentElement && btn.parentElement.nextElementSibling) applyToPreviewElement(btn.parentElement.nextElementSibling);
            });

            // 1.2 Tìm theo nhãn "Ảnh đại diện"
            document.querySelectorAll('label, span, b, strong').forEach(lbl => {
                if (lbl.closest('#da-modal, .da-auto-wrapper')) return;
                const t = lbl.textContent.trim().toLowerCase();
                if (t.includes('ảnh đại diện') || t.includes('hình đại diện') || t.includes('avatar')) {
                    const group = lbl.closest('.form-group, .form-item, .row, [class*="col-"], div') || lbl.parentElement;
                    if (group) {
                        group.querySelectorAll('img').forEach(img => applyToPreviewElement(img));
                        group.querySelectorAll('div, figure, span').forEach(box => {
                            if (box.querySelector('button, label')) return;
                            const r = box.getBoundingClientRect();
                            if (r.width >= 40 && r.height >= 40 && r.width <= 300 && r.height <= 300) {
                                applyToPreviewElement(box);
                            }
                        });
                    }
                }
            });

            // 1.3 Quét các phần tử có chứa chữ "No Image" hoặc "available" trên DOM
            document.querySelectorAll('*').forEach(el => {
                if (el.closest('#da-modal, .da-auto-wrapper, .cke, ckeditor')) return;
                if (el.children.length === 0 || el.tagName === 'IMG') {
                    const t = (el.textContent || '').toLowerCase();
                    const s = (el.getAttribute('src') || '').toLowerCase();
                    const alt = (el.getAttribute('alt') || '').toLowerCase();
                    const bg = (el.style?.backgroundImage || '').toLowerCase();
                    if (t.includes('no image') || t.includes('available') || s.includes('no-image') || s.includes('available') || s.includes('noimage') || alt.includes('no image') || bg.includes('no-image') || bg.includes('available')) {
                        applyToPreviewElement(el.parentElement || el);
                    }
                }
            });

            // 1.4 Gán giá trị URL vào các input ẩn
            const avatarInputs = document.querySelectorAll('input[ng-model*="Avatar" i], input[ng-model*="Image" i], input[name*="Avatar" i], input[name*="Image" i], input[id*="Avatar" i], input[id*="Image" i], input[formcontrolname*="Avatar" i], input[formcontrolname*="Image" i], input[formcontrolname*="Thumb" i]');
            avatarInputs.forEach(inp => {
                inp.value = modelValue;
                inp.dispatchEvent(new Event('input', { bubbles: true }));
                inp.dispatchEvent(new Event('change', { bubbles: true }));
            });
        };

        // Kích hoạt nhiều lần để đón đầu Angular re-render
        runDomAvatarSync();
        setTimeout(runDomAvatarSync, 200);
        setTimeout(runDomAvatarSync, 600);
        setTimeout(runDomAvatarSync, 1200);

        // 3. ĐỒNG BỘ VÀO ANGULAR IVY (Angular 2 - 19+)
        syncToAngularIvy('form, .modal, [role="dialog"], .p-dialog, [formcontrolname], [formgroup], app-news-detail, app-them-moi', comp => {
            let changed = false;
            const fields = ['ImageUrl', 'imageUrl', 'Avatar', 'avatar', 'AvatarUrl', 'avatarUrl', 'Image', 'image', 'ThumbUrl', 'thumbUrl', 'Thumbnail', 'thumbnail'];
            fields.forEach(f => {
                if (f in comp) { comp[f] = modelValue; changed = true; }
                if (comp.item && f in comp.item) { comp.item[f] = modelValue; changed = true; }
                if (comp.model && f in comp.model) { comp.model[f] = modelValue; changed = true; }
                if (comp.form && comp.form.controls && comp.form.controls[f]) {
                    comp.form.controls[f].setValue(modelValue);
                    if (comp.form.controls[f].markAsDirty) comp.form.controls[f].markAsDirty();
                    if (comp.form.controls[f].markAsTouched) comp.form.controls[f].markAsTouched();
                    if (comp.form.controls[f].updateValueAndValidity) comp.form.controls[f].updateValueAndValidity();
                    changed = true;
                }
            });
            return changed;
        });

        // 4. Đồng bộ AngularJS Scope (1.x)
        syncToAngularJs('.modal, form, [ng-controller], [ng-model*="Avatar" i], [ng-model*="Image" i], .modal-dialog, body', scope => {
            if (scope.model) {
                scope.model.Avatar = modelValue;
                scope.model.ImageUrl = modelValue;
                scope.model.Image = modelValue;
            }
            if (scope.item) {
                scope.item.Avatar = modelValue;
                scope.item.ImageUrl = modelValue;
                scope.item.Image = modelValue;
            }
        });
    }

    async function autoSelectArticleType(targetTypeId) {
        let typeIdToSelect = targetTypeId || currentArticleTypeId;

        // Nếu chưa có ID loại bài viết, gọi API lấy danh sách loại tin theo route slug hiện tại
        if (!typeIdToSelect) {
            try {
                const types = await fetchArticleTypesForCurrentCategory();
                if (types && types.length > 0) {
                    typeIdToSelect = types[0].Id;
                    currentArticleTypeId = types[0].Id;
                    currentArticleTypeName = types[0].Name;
                }
            } catch (e) {}
        }

        const applySelection = () => {
            // 1. Quét các thẻ <select> trên form
            const selects = Array.from(document.querySelectorAll('select')).filter(sel => !sel.closest('#da-modal, .da-auto-wrapper'));
            selects.forEach(sel => {
                const fcName = (sel.getAttribute('formcontrolname') || '').toLowerCase();
                const selName = (sel.getAttribute('name') || '').toLowerCase();
                const selId = (sel.getAttribute('id') || '').toLowerCase();
                const ngModel = (sel.getAttribute('ng-model') || '').toLowerCase();
                const parentGroup = sel.closest('.form-group, .form-item, .row, div');
                const labelText = (parentGroup?.querySelector('label, span, b')?.textContent || '').toLowerCase();

                const isArticleTypeSelect = fcName.includes('newtype') || fcName.includes('type') || selName.includes('newtype') || selName.includes('type') || selId.includes('type') || ngModel.includes('newtype') || ngModel.includes('type') || labelText.includes('loại bài viết') || labelText.includes('loại tin') || labelText.includes('chuyên mục') || labelText.includes('danh mục');

                if (isArticleTypeSelect || selects.length === 1) {
                    const options = Array.from(sel.options);
                    if (options.length > 0) {
                        let matchedOption = null;
                        if (typeIdToSelect) {
                            matchedOption = options.find(opt => opt.value === typeIdToSelect);
                        }
                        if (!matchedOption && currentArticleTypeName) {
                            matchedOption = options.find(opt => opt.text && opt.text.trim().toLowerCase() === currentArticleTypeName.trim().toLowerCase());
                        }
                        if (!matchedOption) {
                            // Chọn option đầu tiên hợp lệ (không phải placeholder rỗng/null/"0"/"?")
                            matchedOption = options.find(opt => opt.value && opt.value !== '' && opt.value !== '0' && opt.value !== 'null' && !opt.text.toLowerCase().includes('chọn') && !opt.text.toLowerCase().includes('tất cả'));
                        }

                        if (matchedOption) {
                            sel.value = matchedOption.value;
                            sel.selectedIndex = matchedOption.index;
                            if (!currentArticleTypeId) currentArticleTypeId = matchedOption.value;
                            if (!currentArticleTypeName) currentArticleTypeName = matchedOption.text;

                            sel.dispatchEvent(new Event('input', { bubbles: true }));
                            sel.dispatchEvent(new Event('change', { bubbles: true }));
                            sel.dispatchEvent(new Event('blur', { bubbles: true }));
                        }
                    }
                }
            });

            // 2. Quét các thẻ <ng-select> (Custom Angular Dropdown)
            const ngSelects = Array.from(document.querySelectorAll('ng-select, .ng-select')).filter(el => !el.closest('#da-modal, .da-auto-wrapper'));
            ngSelects.forEach(ngEl => {
                const parentGroup = ngEl.closest('.form-group, .form-item, .row, div');
                const labelText = (parentGroup?.querySelector('label, span, b')?.textContent || '').toLowerCase();
                const fcName = (ngEl.getAttribute('formcontrolname') || '').toLowerCase();

                if (fcName.includes('newtype') || fcName.includes('type') || labelText.includes('loại bài viết') || labelText.includes('loại tin') || labelText.includes('chuyên mục') || ngSelects.length === 1) {
                    // Nếu ng-select đang hiển thị placeholder/chưa có giá trị, thử click để mở danh sách
                    const valContainer = ngEl.querySelector('.ng-value-container');
                    const hasValue = ngEl.querySelector('.ng-value');
                    if (valContainer && !hasValue) {
                        const inputEl = ngEl.querySelector('input');
                        if (inputEl) {
                            inputEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                            inputEl.click();
                            setTimeout(() => {
                                const dropdownPanel = document.querySelector('.ng-dropdown-panel');
                                if (dropdownPanel) {
                                    const firstOpt = dropdownPanel.querySelector('.ng-option:not(.ng-option-disabled)');
                                    if (firstOpt) firstOpt.click();
                                }
                            }, 100);
                        }
                    }
                }
            });

            // 3. Đồng bộ vào Angular Ivy (Angular 2 - 19+)
            syncToAngularIvy('form, .modal, [formcontrolname], select, ng-select, .ng-select, p-dropdown, .p-dropdown', comp => {
                const finalId = typeIdToSelect || currentArticleTypeId;
                if (!finalId) return false;
                let changed = false;
                const typeKeys = ['NewTypeId', 'newTypeId', 'TypeId', 'typeId', 'LoaiTinTucId', 'loaiTinTucId', 'NewsTypeId'];
                typeKeys.forEach(k => {
                    if (k in comp) { comp[k] = finalId; changed = true; }
                    if (comp.item && k in comp.item) { comp.item[k] = finalId; changed = true; }
                    if (comp.model && k in comp.model) { comp.model[k] = finalId; changed = true; }
                    if (comp.form && comp.form.controls && comp.form.controls[k]) {
                        comp.form.controls[k].setValue(finalId);
                        comp.form.controls[k].markAsDirty();
                        comp.form.controls[k].markAsTouched();
                        comp.form.controls[k].updateValueAndValidity();
                        changed = true;
                    }
                });
                // Hỗ trợ NgSelectComponent trực tiếp
                if (comp.itemsList && comp.itemsList.items && comp.itemsList.items.length > 0) {
                    const found = comp.itemsList.items.find(it => (it.value && (it.value.Id === finalId || it.value.id === finalId || it.value === finalId)) || (it.label && it.label === currentArticleTypeName)) || comp.itemsList.items[0];
                    if (found && comp.select) { comp.select(found); changed = true; }
                }
                if (comp.writeValue) { comp.writeValue(finalId); changed = true; }

                if (comp.form) {
                    comp.form.markAsDirty();
                    comp.form.markAsTouched();
                    comp.form.updateValueAndValidity();
                }
                return changed;
            });

            // 4. Đồng bộ AngularJS Scope (1.x)
            syncToAngularJs('.modal, form, [ng-controller], [ng-model*="NewTypeId"], [ng-model*="TypeId"], .modal-dialog, body', scope => {
                const finalId = typeIdToSelect || currentArticleTypeId;
                if (finalId) {
                    if (scope.model) { scope.model.NewTypeId = finalId; }
                    if (scope.item) { scope.item.NewTypeId = finalId; }
                }
            });
        };

        applySelection();
        setTimeout(applySelection, 300);
        setTimeout(applySelection, 800);
        setTimeout(applySelection, 1500);

        if (currentArticleTypeName) {
            logStatus(`Đã tự động chọn Loại bài viết: "${currentArticleTypeName}"`, 'success');
        }
    }

    // ==========================================
    // 9. XỬ LÝ NGÀY VĂN BẢN & NGÀY ĐĂNG (+ 1 NGÀY)
    // ==========================================
    function extractDocumentDateFromText(text, filename = '') {
        if (!text && !filename) return null;
        const combined = `${text}\n${filename}`;

        // 1. Ưu tiên tìm dạng có địa danh ban hành: "Đức An, ngày 06 tháng 09 năm 2026" hoặc "Lâm Đồng, ngày..."
        const placePattern = /(?:[A-ZĐÀ-Ỹ][a-zà-ỹ\s]+,\s*)ngày\s*(\d{1,2})\s*(?:tháng|thang)\s*(\d{1,2})\s*(?:năm|nam)\s*(\d{4})/gi;
        const placeMatches = Array.from(combined.matchAll(placePattern));
        if (placeMatches.length > 0) {
            const m = placeMatches[placeMatches.length - 1];
            const d = parseInt(m[1], 10);
            const month = parseInt(m[2], 10);
            const y = parseInt(m[3], 10);
            if (d >= 1 && d <= 31 && month >= 1 && month <= 12 && y >= 1990 && y <= 2100) {
                return new Date(y, month - 1, d);
            }
        }

        // 2. Dạng chuẩn văn bản hành chính: "ngày 06 tháng 09 năm 2026" (lấy kết quả cuối cùng ở phần chữ ký)
        const vnPattern = /(?:ngày|ngay)\s*(\d{1,2})\s*(?:tháng|thang)\s*(\d{1,2})\s*(?:năm|nam)\s*(\d{4})/gi;
        const allVnMatches = Array.from(combined.matchAll(vnPattern));
        if (allVnMatches.length > 0) {
            for (let i = allVnMatches.length - 1; i >= 0; i--) {
                const m = allVnMatches[i];
                const d = parseInt(m[1], 10);
                const month = parseInt(m[2], 10);
                const y = parseInt(m[3], 10);
                if (d >= 1 && d <= 31 && month >= 1 && month <= 12 && y >= 1990 && y <= 2100) {
                    return new Date(y, month - 1, d);
                }
            }
        }

        // 3. Dạng số DD/MM/YYYY hoặc DD-MM-YYYY (lấy từ dưới lên)
        const dmyPattern = /\b([0-3]?\d)[\/\-\.]([0-1]?\d)[\/\-\.](20\d{2})\b/g;
        const allDmyMatches = Array.from(combined.matchAll(dmyPattern));
        if (allDmyMatches.length > 0) {
            for (let i = allDmyMatches.length - 1; i >= 0; i--) {
                const m = allDmyMatches[i];
                const d = parseInt(m[1], 10);
                const month = parseInt(m[2], 10);
                const y = parseInt(m[3], 10);
                if (d >= 1 && d <= 31 && month >= 1 && month <= 12 && y >= 1990 && y <= 2100) {
                    return new Date(y, month - 1, d);
                }
            }
        }

        return null;
    }

    // Kiểm tra xem văn bản có thuộc phạm vi xã hay của Tỉnh/TW
    function isCommuneLevelDocument(aiIssuerLevel, fullText = '', title = '', documentCode = '', filename = '') {
        // 1. Phân loại từ Gemini AI (so khớp chính xác trước)
        if (aiIssuerLevel) {
            const lvl = aiIssuerLevel.toLowerCase().trim();
            if (lvl === 'xa' || lvl === 'commune' || lvl === 'cap_xa' || lvl.includes('cấp xã') || lvl.includes('ubnd xã') || lvl.includes('hđnd xã')) return true;
            if (lvl === 'tinh_tw' || lvl === 'tinh' || lvl === 'tw' || lvl === 'cap_tinh' || lvl.includes('cấp tỉnh') || lvl.includes('trung ương') || lvl.includes('tỉnh')) return false;
        }

        // 2. Phân loại theo Tiêu đề bài viết
        const lowerTitle = (title || '').toLowerCase();
        if (lowerTitle.includes('xã đức an ban hành') || lowerTitle.includes('ubnd xã đức an ban hành') || lowerTitle.includes('ubnd xã ban hành') || lowerTitle.includes('hđnd xã ban hành') || lowerTitle.includes('xã đức an')) {
            return true;
        }
        if (lowerTitle.startsWith('lâm đồng ban hành') || lowerTitle.includes('ubnd tỉnh ban hành') || lowerTitle.includes('thủ tướng') || lowerTitle.includes('bộ tài chính') || lowerTitle.includes('chính phủ ban hành')) {
            return false;
        }

        // 3. Phân loại theo Số hiệu văn bản
        const lowerCode = (documentCode || '').toLowerCase();
        if (lowerCode.includes('/ubnd-xda') || lowerCode.includes('/ubnd-xa') || lowerCode.includes('/hđnd-xa')) {
            return true;
        }
        if (lowerCode.includes('/ubnd-vp') || lowerCode.includes('/ubnd-th') || lowerCode.includes('/ubnd-nv') || lowerCode.includes('/vp-ubnd')) {
            return false;
        }

        // 4. Phân tích nội dung theo Header (1000 ký tự đầu) và Footer (1200 ký tự cuối)
        // Tránh kiểm tra toàn văn vì phần "Căn cứ..." của cấp Xã thường trích dẫn Quyết định của UBND Tỉnh
        const headerText = (fullText ? fullText.slice(0, 1000) : '').toLowerCase();
        const footerText = (fullText ? fullText.slice(-1200) : '').toLowerCase();
        const fileLow = (filename || '').toLowerCase();

        // 4.1. Dấu hiệu cấp Xã ở Header (cơ quan ban hành) hoặc Footer (chữ ký)
        const isCommuneInHeader = headerText.includes('xã đức an') || headerText.includes('ubnd xã đức an') || headerText.includes('hđnd xã đức an');
        const isCommuneInFooter = footerText.includes('đức an, ngày') || footerText.includes('tm. ủy ban nhân dân xã') || (footerText.includes('chủ tịch') && footerText.includes('đức an'));
        const isCommuneInFilename = fileLow.includes('xda') || fileLow.includes('duc an') || fileLow.includes('ducan');

        if (isCommuneInHeader || isCommuneInFooter || isCommuneInFilename) {
            return true;
        }

        // 4.2. Dấu hiệu cấp Tỉnh / TW ở Header hoặc Footer
        const isHigherInHeader = headerText.includes('ủy ban nhân dân tỉnh lâm đồng') || headerText.includes('ubnd tỉnh lâm đồng') || headerText.includes('thủ tướng chính phủ') || headerText.includes('bộ tài chính') || headerText.includes('bộ giao thông');
        const isHigherInFooter = footerText.includes('lâm đồng, ngày') || footerText.includes('hà nội, ngày');

        if (isHigherInHeader || isHigherInFooter) {
            return false;
        }

        // 4.3. Nếu không xác định rõ ở Header/Footer, kiểm tra từ khóa toàn văn
        const fullLow = fullText.toLowerCase();
        if (fullLow.includes('ubnd xã đức an') || fullLow.includes('đức an, ngày')) {
            return true;
        }

        return false;
    }

    function parseDateString(str) {
        if (!str) return null;
        if (str instanceof Date && !isNaN(str.getTime())) return str;
        if (typeof str !== 'string') return null;

        const dmy = str.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
        if (dmy) {
            const d = parseInt(dmy[1], 10);
            const m = parseInt(dmy[2], 10);
            const y = parseInt(dmy[3], 10);
            if (d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 1990 && y <= 2100) {
                return new Date(y, m - 1, d);
            }
        }

        const ymd = str.match(/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
        if (ymd) {
            const y = parseInt(ymd[1], 10);
            const m = parseInt(ymd[2], 10);
            const d = parseInt(ymd[3], 10);
            if (d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 1990 && y <= 2100) {
                return new Date(y, m - 1, d);
            }
        }

        const vn = str.match(/(?:ngày|ngay)?\s*(\d{1,2})\s*(?:tháng|thang)\s*(\d{1,2})\s*(?:năm|nam)\s*(\d{4})/i);
        if (vn) {
            const d = parseInt(vn[1], 10);
            const m = parseInt(vn[2], 10);
            const y = parseInt(vn[3], 10);
            if (d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 1990 && y <= 2100) {
                return new Date(y, m - 1, d);
            }
        }

        return null;
    }

    function computePublishDate(docDateOrString, fullText = '', filename = '', title = '', documentCode = '', aiIssuerLevel = '') {
        const now = new Date();
        const isCommune = isCommuneLevelDocument(aiIssuerLevel, fullText, title, documentCode, filename);
        let baseDate = parseDateString(docDateOrString) || extractDocumentDateFromText(fullText, filename);

        // Nếu người dùng đã tự chỉnh sửa thủ công ngày trên form trước đó, ưu tiên sử dụng ngày người dùng đã chọn
        if (isDateManuallyEditedByUser && currentPublishDateStr) {
            const manualDate = parseDateString(currentPublishDateStr);
            if (manualDate) {
                manualDate.setHours(now.getHours(), now.getMinutes(), now.getSeconds());
                return {
                    dateObj: manualDate,
                    docDateObj: baseDate,
                    isComputedFromDoc: false,
                    isCommune: isCommune,
                    isManualUserDate: true
                };
            }
        }

        if (isCommune) {
            // Nếu thuộc phạm vi XÃ: +1 ngày so với ngày văn bản
            if (baseDate && !isNaN(baseDate.getTime())) {
                const targetDate = new Date(baseDate.getTime());
                targetDate.setDate(targetDate.getDate() + 1);
                targetDate.setHours(now.getHours(), now.getMinutes(), now.getSeconds());
                return {
                    dateObj: targetDate,
                    docDateObj: baseDate,
                    isComputedFromDoc: true,
                    isCommune: true
                };
            }
        } else {
            // Nếu của TỈNH hay TRUNG ƯƠNG: không + thêm, để ngày hiện tại
            return {
                dateObj: now,
                docDateObj: baseDate,
                isComputedFromDoc: false,
                isCommune: false
            };
        }

        // Mặc định ngày hiện tại nếu không lấy được ngày văn bản
        return {
            dateObj: now,
            docDateObj: null,
            isComputedFromDoc: false,
            isCommune: isCommune
        };
    }

    function formatDateToCMS(d) {
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        const hours = String(d.getHours()).padStart(2, '0');
        const minutes = String(d.getMinutes()).padStart(2, '0');
        const seconds = String(d.getSeconds()).padStart(2, '0');
        return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
    }

    function setPublishDateToForm(dateResult) {
        const formattedStr = formatDateToCMS(dateResult.dateObj);
        currentPublishDateStr = formattedStr;

        const applyDate = () => {
            const matchedInputs = new Set();

            // 1. Tìm thẻ p-calendar
            document.querySelectorAll('p-calendar, .p-calendar').forEach(pCal => {
                if (pCal.closest('#da-modal, .da-auto-wrapper')) return;
                const inp = pCal.querySelector('input');
                if (inp) matchedInputs.add(inp);
            });

            // 2. Tìm input theo nhãn "Ngày đăng"
            document.querySelectorAll('label, span, div, b, strong').forEach(lbl => {
                if (lbl.closest('#da-modal, .da-auto-wrapper')) return;
                const txt = lbl.textContent.trim().toLowerCase();
                if (txt.includes('ngày đăng') || txt.includes('ngay dang') || txt.includes('ngày xuất bản')) {
                    const container = lbl.closest('.form-group, .form-item, .row, div') || lbl.parentElement;
                    if (container) {
                        const inp = container.querySelector('input');
                        if (inp && !inp.closest('#da-modal, .da-auto-wrapper')) matchedInputs.add(inp);
                    }
                }
            });

            // 3. Tìm input theo formcontrolname hoặc ng-model chứa create/publish/date
            document.querySelectorAll('input[formcontrolname*="date" i], input[formcontrolname*="createdate" i], input[formcontrolname*="publish" i], input[ng-model*="CreateDate"], input[name*="CreateDate"]').forEach(inp => {
                if (!inp.closest('#da-modal, .da-auto-wrapper')) matchedInputs.add(inp);
            });

            matchedInputs.forEach(inp => {
                setNativeInputValue(inp, formattedStr);

                // Đồng bộ Angular Ivy (Angular 2 - 19+) cho ô input và p-calendar
                syncToAngularIvy(inp, comp => {
                    let changed = false;
                    if (comp.writeValue) { comp.writeValue(dateResult.dateObj); changed = true; }
                    if (comp.updateModel) { comp.updateModel(dateResult.dateObj); changed = true; }
                    if (comp.form && comp.form.controls) {
                        const dateControls = ['StrCreateDate', 'strCreateDate', 'CreateDate', 'createDate', 'PublishDate', 'publishDate', 'NgayDang', 'ngayDang'];
                        dateControls.forEach(k => {
                            if (comp.form.controls[k]) {
                                comp.form.controls[k].setValue(formattedStr);
                                if (comp.form.controls[k].markAsDirty) comp.form.controls[k].markAsDirty();
                                if (comp.form.controls[k].markAsTouched) comp.form.controls[k].markAsTouched();
                                if (comp.form.controls[k].updateValueAndValidity) comp.form.controls[k].updateValueAndValidity();
                                changed = true;
                            }
                        });
                    }
                    return changed;
                });

                const pCalEl = inp.closest('p-calendar');
                if (pCalEl) {
                    syncToAngularIvy(pCalEl, pCalComp => {
                        if (pCalComp.writeValue) pCalComp.writeValue(dateResult.dateObj);
                        if (pCalComp.updateModel) pCalComp.updateModel(dateResult.dateObj);
                        if (pCalComp.value !== undefined) pCalComp.value = dateResult.dateObj;
                        if (pCalComp.inputFieldValue !== undefined) pCalComp.inputFieldValue = formattedStr;
                        pCalComp.currentMonth = dateResult.dateObj.getMonth();
                        pCalComp.currentYear = dateResult.dateObj.getFullYear();
                        if (pCalComp.createMonth) pCalComp.createMonth(pCalComp.currentMonth, pCalComp.currentYear);
                        return true;
                    });
                }

                // Đồng bộ AngularJS Scope (1.x)
                syncToAngularJs(inp, scope => {
                    if (scope.model) { scope.model.StrCreateDate = formattedStr; scope.model.CreateDate = formattedStr; }
                    if (scope.item) { scope.item.StrCreateDate = formattedStr; scope.item.CreateDate = formattedStr; }
                });
            });
        };

        applyDate();
        setTimeout(applyDate, 300);
        setTimeout(applyDate, 800);
        setTimeout(applyDate, 1500);

        if (dateResult.isManualUserDate) {
            logStatus(`Đã giữ nguyên Ngày đăng theo giá trị bạn tự chọn trên Form: ${formattedStr.split(' ')[0]}`, 'info');
        } else if (dateResult.isCommune && dateResult.isComputedFromDoc && dateResult.docDateObj) {
            const docD = formatDateToCMS(dateResult.docDateObj).split(' ')[0];
            const pubD = formattedStr.split(' ')[0];
            logStatus(`Đã đặt Ngày đăng: ${pubD} (+1 ngày so với ngày văn bản xã ${docD})`, 'success');
        } else if (!dateResult.isCommune) {
            logStatus(`Văn bản cấp Tỉnh/TW: giữ Ngày đăng là ngày hiện tại (${formattedStr})`, 'info');
        } else {
            logStatus(`Đã đặt Ngày đăng: ${formattedStr}`, 'info');
        }
    }

    // ==========================================
    // 10. VIỆT HÓA THÁNG & THỨ TRONG BỘ CHỌN LỊCH (CALENDAR SELECTOR)
    // ==========================================
    const MONTH_MAP_VI = {
        'january': 'Tháng 1',
        'february': 'Tháng 2',
        'march': 'Tháng 3',
        'april': 'Tháng 4',
        'may': 'Tháng 5',
        'june': 'Tháng 6',
        'july': 'Tháng 7',
        'august': 'Tháng 8',
        'september': 'Tháng 9',
        'october': 'Tháng 10',
        'november': 'Tháng 11',
        'december': 'Tháng 12',
        'jan': 'Tháng 1',
        'feb': 'Tháng 2',
        'mar': 'Tháng 3',
        'apr': 'Tháng 4',
        'may': 'Tháng 5',
        'jun': 'Tháng 6',
        'jul': 'Tháng 7',
        'aug': 'Tháng 8',
        'sep': 'Tháng 9',
        'oct': 'Tháng 10',
        'nov': 'Tháng 11',
        'dec': 'Tháng 12'
    };

    const DAY_MAP_VI = {
        'su': 'CN', 'sun': 'CN', 'sunday': 'CN',
        'mo': 'T2', 'mon': 'T2', 'monday': 'T2',
        'tu': 'T3', 'tue': 'T3', 'tuesday': 'T3',
        'we': 'T4', 'wed': 'T4', 'wednesday': 'T4',
        'th': 'T5', 'thu': 'T5', 'thursday': 'T5',
        'fr': 'T6', 'fri': 'T6', 'friday': 'T6',
        'sa': 'T7', 'sat': 'T7', 'saturday': 'T7'
    };

    function localizeCalendarDOM() {
        const datepickers = document.querySelectorAll('.p-datepicker, .ui-datepicker, p-calendar .p-datepicker-panel');
        if (datepickers.length === 0) return;

        datepickers.forEach(dp => {
            // 1. Việt hoá tên Tháng ở tiêu đề (VD: "September" -> "Tháng 9")
            const monthSpans = dp.querySelectorAll('.p-datepicker-month, .ui-datepicker-month');
            monthSpans.forEach(mEl => {
                const raw = mEl.textContent.trim().toLowerCase();
                if (MONTH_MAP_VI[raw]) {
                    mEl.textContent = MONTH_MAP_VI[raw];
                }
            });

            // Nếu tiêu đề dạng text node trực tiếp trong .p-datepicker-title (VD: "September 2026")
            const titleEls = dp.querySelectorAll('.p-datepicker-title, .ui-datepicker-title');
            titleEls.forEach(tEl => {
                for (const node of tEl.childNodes) {
                    if (node.nodeType === Node.TEXT_NODE && node.nodeValue) {
                        let text = node.nodeValue;
                        Object.keys(MONTH_MAP_VI).forEach(enMonth => {
                            const regex = new RegExp(`\\b${enMonth}\\b`, 'gi');
                            if (regex.test(text)) {
                                text = text.replace(regex, MONTH_MAP_VI[enMonth]);
                            }
                        });
                        node.nodeValue = text;
                    }
                }
            });

            // 2. Việt hoá <select> chọn tháng (nếu p-calendar cấu hình monthNavigator)
            const monthSelects = dp.querySelectorAll('select.p-datepicker-month, select.ui-datepicker-month');
            monthSelects.forEach(sel => {
                Array.from(sel.options).forEach(opt => {
                    const raw = opt.text.trim().toLowerCase();
                    if (MONTH_MAP_VI[raw]) {
                        opt.text = MONTH_MAP_VI[raw];
                    }
                });
            });

            // 3. Việt hoá lưới chọn tháng (.p-monthpicker)
            const monthPickerItems = dp.querySelectorAll('.p-monthpicker-month, .ui-monthpicker-month');
            monthPickerItems.forEach(item => {
                const raw = item.textContent.trim().toLowerCase();
                if (MONTH_MAP_VI[raw]) {
                    item.textContent = MONTH_MAP_VI[raw];
                }
            });

            // 4. Việt hoá thứ trong tuần (Su, Mo, Tu, We, Th, Fr, Sa -> CN, T2, T3, T4, T5, T6, T7)
            const daySpans = dp.querySelectorAll('.p-datepicker-calendar th span, table thead th span');
            if (daySpans.length > 0) {
                daySpans.forEach(sp => {
                    const raw = sp.textContent.trim().toLowerCase();
                    if (DAY_MAP_VI[raw]) {
                        sp.textContent = DAY_MAP_VI[raw];
                    }
                });
            } else {
                const dayHeaders = dp.querySelectorAll('table thead th, .p-datepicker-calendar th');
                dayHeaders.forEach(th => {
                    const raw = th.textContent.trim().toLowerCase();
                    if (DAY_MAP_VI[raw]) {
                        th.textContent = DAY_MAP_VI[raw];
                    }
                });
            }
        });
    }

    function configurePrimeNgLocale() {
        syncToAngularIvy('p-calendar', comp => {
            if (comp && comp.config && comp.config.setTranslation) {
                comp.config.setTranslation({
                    dayNames: ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"],
                    dayNamesShort: ["CN", "T2", "T3", "T4", "T5", "T6", "T7"],
                    dayNamesMin: ["CN", "T2", "T3", "T4", "T5", "T6", "T7"],
                    monthNames: ["Tháng 1", "Tháng 2", "Tháng 3", "Tháng 4", "Tháng 5", "Tháng 6", "Tháng 7", "Tháng 8", "Tháng 9", "Tháng 10", "Tháng 11", "Tháng 12"],
                    monthNamesShort: ["Tháng 1", "Tháng 2", "Tháng 3", "Tháng 4", "Tháng 5", "Tháng 6", "Tháng 7", "Tháng 8", "Tháng 9", "Tháng 10", "Tháng 11", "Tháng 12"],
                    today: "Hôm nay",
                    clear: "Xóa",
                    dateFormat: "dd/mm/yy",
                    weekHeader: "Tuần"
                });
                return true;
            }
            return false;
        });
    }

})();
