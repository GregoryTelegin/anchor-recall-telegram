import { createMiniAppLocalState } from "./miniapp-local-state";
import { createMiniAppCatalog } from "./miniapp-catalog";
import { createMiniAppMediaCache } from "./miniapp-media-cache";
import { readMiniAppVaultAuth } from "./miniapp-vaults";

/** Static, isolated Mini App assets. Card and learner strings are added through textContent only. */
export const miniAppHtml = String.raw`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>Anchor Recall — занятие</title><link rel="stylesheet" href="/miniapp/app.css"><script src="https://telegram.org/js/telegram-web-app.js" defer></script><script src="/miniapp/app.js" defer></script></head>
<body><div class="ar-app"><header class="ar-chrome"><div class="ar-brand"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="4" r="2.4"></circle><path d="M12 6.5V21M7 10h10M3 14a9 9 0 0 0 18 0M3 14l-1 4m1-4 4 1m14-1 1 4m-1-4-4 1"></path></svg><span>Anchor Recall</span></div><span id="activity" class="ar-activity" aria-hidden="true"></span><button id="fullscreen" class="ar-ghost ar-fullscreen" type="button" aria-label="Развернуть" title="Развернуть" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path id="fullscreen-icon" d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"></path></svg></button><button id="close" class="ar-ghost" type="button">В чат</button></header>
<p id="window-status" class="ar-window-status" role="status" hidden></p>
<div id="error" class="ar-error" role="alert" hidden><strong id="error-title"></strong><p id="error-text"></p><div class="ar-error-actions"><button id="retry" type="button">Повторить</button><button id="error-close" class="ar-ghost" type="button">В чат</button></div></div>
<main id="content" class="ar-main" tabindex="-1"><section class="ar-landing"><h1>Открываем занятие…</h1><p>Подключаемся к выбранным материалам.</p></section></main><p id="live" class="ar-sr" role="status" aria-live="polite"></p><noscript><p>Для занятия нужен JavaScript. Откройте экран кнопкой в Telegram.</p></noscript></div></body></html>`;

export const miniAppClientScript = String.raw`(() => {
'use strict';
const tg = window.Telegram && window.Telegram.WebApp;
const $ = id => document.getElementById(id), root = $('content');
const planParams = new URLSearchParams(location.search).getAll('plan');
const vaultParams = new URLSearchParams(location.hash.slice(1)).getAll('vault');
const launchVaultId = vaultParams.length === 1 && /^[a-f0-9]{48}$/.test(vaultParams[0]) ? vaultParams[0] : '';
const invalidVaultLink = vaultParams.length > 0 && !launchVaultId;
const readVaultAuth = (${readMiniAppVaultAuth.toString()});
function launchPlanId(value) { if (typeof value !== 'string' || !/^p_[A-Za-z0-9_-]{43}$/.test(value)) return ''; try { const bytes = atob(value.slice(2).replace(/-/g,'+').replace(/_/g,'/') + '='); if (bytes.length !== 32 || btoa(bytes).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_') !== value.slice(2)) return ''; return Array.from(bytes,ch => ch.charCodeAt(0).toString(16).padStart(2,'0')).join(''); } catch (_) { return ''; } }
let planId = planParams.length === 1 && planParams[0].length === 64 && /^[a-f0-9]{64}$/.test(planParams[0]) ? planParams[0] : !planParams.length ? launchPlanId(tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) : '';
const labels = ['', 'Ещё раз', 'Трудно', 'Хорошо', 'Легко'];
const kinds = {single:'Один вариант',multiple:'Несколько вариантов',cloze:'Пропуски',matching:'Сопоставление',ordering:'Порядок',exact:'Точный ответ',self:'Самопроверка'};
const statuses = {pending:'Сохранено в боте',syncing:'Передаётся в Obsidian',applied:'Сохранено в Obsidian',correcting:'Изменение оценки ожидает Obsidian','correction-rejected':'Изменение не применено; сохранена прежняя оценка',stale:'Не применено: карточка изменилась',missing:'Не применено: карточка недоступна',ineligible:'Не применено: повтор недоступен',expired:'Не применено: срок данных истёк','clock-mismatch':'Не применено: проверьте время','epoch-mismatch':'Не применено: подключение изменилось','local-session-active':'Не применено: идёт занятие в Obsidian','core-adapter-unavailable':'Не применено: расписание недоступно'};
let bearer = '', current = null, busy = false, pending = null, retryWork = null, locked = false;
let vaultId = '', vaults = [], storageScope = '', contextGeneration = 0;
const vaultDrafts = new Map();
let draft = {key:'',selected:[],text:'',blanks:[],matches:[],order:[]}, cardDom = null, editingGrade = false, historySize = 20;
let recoveredDraft = '', selectedPreset = '', presetName = '', presetFeedback = '', presetsOpen = false;
function storageFailure() { const notice = $('window-status'); notice.textContent = 'Не удалось сохранить данные на этом устройстве. Незавершённый ответ может потеряться после закрытия окна.'; notice.hidden = false; }
function localStore() {
  const api = tg && tg.DeviceStorage; let native = false; try { native = !!tg && typeof tg.isVersionAtLeast === 'function' && tg.isVersionAtLeast('9.0'); } catch (_) {}
  if (native && api && ['getItem','setItem','removeItem'].every(method => typeof api[method] === 'function')) {
    const call = (method,args) => new Promise((resolve,reject) => { const timer = setTimeout(() => reject(new Error('storage unavailable')),1200); try { api[method](...args,(error,value) => { clearTimeout(timer); if (error || (method === 'getItem' ? value !== null && typeof value !== 'string' : value !== true)) reject(new Error('storage unavailable')); else resolve(value); }); } catch (_) { clearTimeout(timer); reject(new Error('storage unavailable')); } });
    return {get:key => call('getItem',[key]),set:(key,value) => call('setItem',[key,value]),remove:key => call('removeItem',[key])};
  }
  try { const storage = window.localStorage; if (!storage) return null; return {get:async key => storage.getItem(key),set:async (key,value) => storage.setItem(key,value),remove:async key => storage.removeItem(key)}; } catch (_) { return null; }
}
const localState = (${createMiniAppLocalState.toString()})(localStore(),storageFailure);
function retainDraft() { return !current || current.answerHistorySupported !== true || current.retainAnswers === true; }
function persistDraft() { if (!retainDraft()) { if (localState.available()) void localState.clearDraft(); return; } if (localState.available() && current && current.status === 'question' && current.card && !current.card.result && !current.card.selectedRating && draft.key) void localState.saveDraft(draft); }
let picker = false, startConflict = '', shuffleCards = false, studyMode = 'core', busyTimer, waitingTimer, busyFocus = null, mediaEpoch = 0, mediaActive = 0;
let homeScreenStatus = '', homeScreenMessage = '', homeScreenDom = null;
let launch = null, planPrepared = false, planChoosing = !!planId, planContinued = false;
let sectionView = 'study', today = null, week = null, planRange = 'today', settingsPrepared = false, historyOpen = false, presetRefresh = null;
let studyTargetExpanded = true;
const planEdits = new Map(), cardReportEdits = new Map();
let filterPopupClose = null, topicRecallExpanded = false, topicRecallSelected = '';
let resumeNeeded = false, resumeTimer = null, resumeReading = null;
let waitingDom = null, serverClock = null;
let lifetimeTimer = null, connectionExpiresAt = 0, connectionHardExpiresAt = 0;
let lessonTimer = null, sessionTimerDom = null, mediaSuspended = false;
const startSettings = {core:{cardLimit:'',timeLimitMinutes:''},bank:{cardLimit:'',timeLimitMinutes:''}}, settingsOpen = {core:false,bank:false}, studyFilters = {core:{learningGroup:'',questionKind:'',section:'',topic:'',tag:'',knowledgeState:''},bank:{learningGroup:'',questionKind:'',section:'',topic:'',tag:'',knowledgeState:''}};
const knowledgeStateLabels = {new:'Новая',learning:'Изучается','needs-attention':'На уточнении',weak:'Слабая',stable:'Стабильная',strong:'Сильная'};
const mediaQueue = [], mediaEntries = new Map(), mediaControllers = new Set(), objectUrls = new Set(), mediaNodes = new Set();
const mediaCache = (${createMiniAppMediaCache.toString()})();
const mediaDeferred = new Set();
const materialSelections = {core:new Set(),bank:new Set()};
const catalogModel = (${createMiniAppCatalog.toString()})();
const modeOf = row => row && row.mode === 'bank' ? 'bank' : 'core';
const modeLabel = mode => mode === 'bank' ? 'Банк вопросов' : 'Повторения Core';
const modeMaterials = mode => materialCatalog(mode).modeMaterials;
const selectedMaterials = mode => materialSelections[mode || studyMode];
const viewRequest = () => planId ? {kind:'plan',id:planId,answerHistoryVersion:1} : {kind:'view',answerHistoryVersion:1};
const unfinished = () => current && current.session && ['question','result','waiting','paused'].includes(current.status);
function materialCatalog(mode) { return catalogModel.forView(current,mode || studyMode,planChoosing && planId ? launch : undefined); }
function targetMaterials(mode) { return materialCatalog(mode).materials; }
function catalogCards(mode) { return materialCatalog(mode).cards; }
function matchesStudyFilter(card,filter) { return catalogModel.matches(card,filter); }
function pickerMaterials(mode) { return materialCatalog(mode).filtered(studyFilters[mode || studyMode]); }
function sessionLimitFields(mode) { const values = startSettings[mode || studyMode], fields = {}; for (const [key,max] of [['cardLimit',1000],['timeLimitMinutes',90]]) { const raw = values[key].trim(); if (!raw) continue; const number = Number(raw); if (!/^\d+$/.test(raw) || !Number.isSafeInteger(number) || number < 1 || number > max) return null; fields[key] = number; } return fields; }
function startFields(mode) { const chosenMode = mode || studyMode, fields = sessionLimitFields(chosenMode); if (!fields) return null; for (const [key,value] of Object.entries(studyFilters[chosenMode])) if (value) fields[key] = value; return fields; }
function tagFilterLabels(cards) { return catalogModel.tagLabels(cards); }
function el(tag, cls, text) { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; }
function button(text, work, cls) { const node = el('button', cls || '', text); node.type = 'button'; node.addEventListener('click', work); return node; }
function cancelOrderInteraction() { if (cardDom && cardDom.cancelOrder) cardDom.cancelOrder(); }
async function close() { cancelOrderInteraction(); persistDraft(); closeFilterPicker(); releaseMedia(); await localState.flush(); if (tg && typeof tg.close === 'function') tg.close(); }
function setupFullscreen() { const control = $('fullscreen'), notice = $('window-status');
  try { if (!tg || typeof tg.isVersionAtLeast !== 'function' || !tg.isVersionAtLeast('8.0') || typeof tg.requestFullscreen !== 'function' || typeof tg.exitFullscreen !== 'function' || typeof tg.onEvent !== 'function') return;
    const sync = () => { const full = tg.isFullscreen === true, label = full ? 'Свернуть' : 'Развернуть'; control.setAttribute('aria-label',label); control.setAttribute('aria-pressed',String(full)); control.title = label; control.disabled = false; $('fullscreen-icon').setAttribute('d',full ? 'M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5' : 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5'); };
    const failed = () => { sync(); notice.textContent = 'Не удалось изменить режим окна. Можно продолжить занятие.'; notice.hidden = false; };
    tg.onEvent('fullscreenChanged',() => { sync(); notice.hidden = true; }); tg.onEvent('fullscreenFailed',failed);
    control.addEventListener('click',() => { control.disabled = true; notice.hidden = true; try { if (tg.isFullscreen === true) tg.exitFullscreen(); else tg.requestFullscreen(); } catch (_) { failed(); } }); sync(); control.hidden = false;
  } catch (_) { control.hidden = true; }
}
function updateHomeScreenAction() { if (!homeScreenDom) return; homeScreenDom.section.hidden = homeScreenStatus !== 'unknown' && homeScreenStatus !== 'missed'; homeScreenDom.notice.textContent = homeScreenMessage; homeScreenDom.notice.hidden = !homeScreenMessage; }
function setupHomeScreen() {
  try { if (!tg || typeof tg.isVersionAtLeast !== 'function' || !tg.isVersionAtLeast('8.0') || typeof tg.checkHomeScreenStatus !== 'function' || typeof tg.addToHomeScreen !== 'function') return;
    if (typeof tg.onEvent === 'function') tg.onEvent('homeScreenAdded',() => { homeScreenStatus = 'added'; homeScreenMessage = ''; updateHomeScreenAction(); });
    tg.checkHomeScreenStatus(status => { if (homeScreenStatus === 'added') return; homeScreenStatus = ['unsupported','unknown','added','missed'].includes(status) ? status : ''; updateHomeScreenAction(); });
  } catch (_) { homeScreenStatus = ''; updateHomeScreenAction(); }
}
function theme() { document.documentElement.dataset.theme = tg && tg.colorScheme === 'dark' || !tg && matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'; }
function announce(text) { $('live').textContent = text; }
function setBusy(value, message) { if (value) { cancelOrderInteraction(); closeFilterPicker(true); busyFocus = root.contains(document.activeElement) ? document.activeElement : null; } busy = value; clearTimeout(busyTimer); $('activity').dataset.busy = 'false'; root.setAttribute('aria-busy', String(value)); if (value) { announce(message || 'Загружаем…'); busyTimer = setTimeout(() => { $('activity').dataset.busy = 'true'; }, 150); } updateDisabled(); if (!value && busyFocus) { if (busyFocus.isConnected && !busyFocus.disabled && !busyFocus.closest('[hidden]')) busyFocus.focus({preventScroll:true}); busyFocus = null; } if (!value && resumeNeeded) scheduleResume(); }
function updateDisabled() { root.querySelectorAll('button,input,textarea,select').forEach(node => { node.disabled = node.dataset.localAction !== 'true' && (busy || locked || node.dataset.unavailable === 'true' || !!pending); }); if (cardDom) { cardDom.renderOrder(); updateCheck(); } }
function clearError() { $('error').hidden = true; retryWork = null; }
function error(title, text, retry) { $('error-title').textContent = title; $('error-text').textContent = text; $('error').hidden = false; retryWork = retry || null; $('retry').hidden = !retry; $('error-close').hidden = !tg; announce(title + '. ' + text); }
function failure(status) { const problem = new Error('request failed'); problem.status = status || 0; return problem; }
async function post(path, body, authenticated, credential) {
  if (path === '/miniapp/study' && ['view','plan','today'].includes(body.kind)) body = Object.assign({},body,{answerHistoryVersion:1});
  const generation = contextGeneration, controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
  try { const headers = {'Content-Type':'application/json'}; if (authenticated) headers.Authorization = 'Bearer ' + (credential === undefined ? bearer : credential);
    const response = await fetch(path, {method:'POST',headers,body:JSON.stringify(body),signal:controller.signal,credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
    if (generation !== contextGeneration) throw failure(-1);
    if (!response.ok) throw failure(response.status); const value = await response.json(); if (generation !== contextGeneration) throw failure(-1); return value;
  } catch (problem) { if (problem && Number.isInteger(problem.status)) throw problem; throw failure(0); } finally { clearTimeout(timer); }
}
function handleFailure(problem, retry) {
  if (problem.status === -1) return;
  if (problem.status === 401 || problem.status === 403) { endConnection(); }
  else if (problem.status === 400) { const failedStart = preserveFailedStart(); pending = null; if (failedStart) render(); error(failedStart ? 'Занятие не запущено' : 'Действие недоступно', failedStart ? 'Занятие «' + startConflict + '» не запущено. Обновите список материалов и попробуйте снова.' : 'Данные могли измениться. Обновите экран и попробуйте снова.', () => loadView()); }
  else if (problem.status === 429) error('Нужно немного подождать', 'Сервис получил много запросов. Повторите попытку чуть позже.', retry);
  else error('Не удалось получить ответ', pending && pending.kind === 'resume' ? 'Не удалось восстановить занятие. Текущий вопрос и введённый ответ остаются в этом окне. Повторите подключение.' : pending && pending.kind === 'pause' ? 'Не удалось подтвердить паузу. Повторим тот же запрос; сохранённые ответы и оценки не изменятся.' : pending && pending.kind === 'finish-chat' ? 'Не удалось подтвердить завершение. Повторим тот же запрос; выставленные оценки сохранятся.' : pending ? retainDraft() ? 'Ввод сохранён. Повторим тот же запрос, чтобы не записать ответ дважды.' : 'Ввод остаётся в открытом окне. Повторим тот же запрос, чтобы не записать оценку дважды.' : 'Проверьте соединение и повторите попытку.', retry);
}
function preserveFailedStart() { if (!pending || pending.kind !== 'start') return false; const ids = pending.materialIds || [pending.materialId]; if (pending.mode) studyMode = pending.mode; startConflict = pending.retryWeak === true ? 'Трудные вопросы' : pending.allMaterials === true ? 'Все материалы' : modeMaterials().filter(row => ids.includes(row.id)).map(row => row.title).join(' + ') || 'Выбранные материалы'; picker = true; return true; }
function permutation(values, length) { return Array.isArray(values) && values.length === length && values.every(value => Number.isSafeInteger(value) && value >= 0 && value < length) && new Set(values).size === length; }
function validExerciseView(card) { if (!card || card.kind !== 'matching' && card.kind !== 'ordering') return true; const strings = values => Array.isArray(values) && values.length >= 2 && values.length <= 12 && values.every(value => typeof value === 'string' && value.trim().length > 0 && value.length <= 500);
  if (card.kind === 'matching') return card.matching && strings(card.matching.left) && strings(card.matching.right) && card.matching.left.length === card.matching.right.length && (!card.result || permutation(card.result.correctMatches,card.matching.left.length) && (!card.result.feedback || card.result.feedback.kind === 'matching' && permutation(card.result.feedback.matches,card.matching.left.length)));
  return strings(card.orderItems) && (!card.result || permutation(card.result.correctOrder,card.orderItems.length) && (!card.result.feedback || card.result.feedback.kind === 'ordering' && permutation(card.result.feedback.order,card.orderItems.length)));
}
function validToday(value) { return value && typeof value.timeZone === 'string' && Number.isSafeInteger(value.generatedAt) && Number.isSafeInteger(value.expiresAt) && Array.isArray(value.rows) && value.rows.every(row => row && typeof row.id === 'string' && row.id.length === 64 && /^[a-f0-9]{64}$/.test(row.id) && typeof row.title === 'string' && Number.isSafeInteger(row.startAt) && (row.completed === undefined || typeof row.completed === 'boolean') && (row.skipped === undefined || typeof row.skipped === 'boolean') && typeof row.available === 'boolean'); }
function validStudyTarget(value) { if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id) || typeof value.targetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.targetDate) || !Number.isFinite(Date.parse(value.targetDate + 'T00:00:00Z')) || new Date(value.targetDate + 'T00:00:00Z').toISOString().slice(0,10) !== value.targetDate || typeof value.timeZone !== 'string' || !['active','transition','completed','disabled','stale'].includes(value.status) || !Number.isSafeInteger(value.available) || value.available < 0 || !Number.isSafeInteger(value.total) || value.total < value.available || value.total > 1000 || !Number.isSafeInteger(value.syncedAt) || value.syncedAt < 0 || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= value.syncedAt || value.nextDueAt !== undefined && (!Number.isSafeInteger(value.nextDueAt) || value.nextDueAt < 0)) return false; try { new Intl.DateTimeFormat('ru-RU',{timeZone:value.timeZone}).format(value.syncedAt); return true; } catch (_) { return false; } }
function validView(value) { return value && ['materials','question','result','waiting','paused','finished','unavailable','chat-active'].includes(value.status) && typeof value.viewToken === 'string' && value.viewToken.length === 64 && /^[a-f0-9]{64}$/.test(value.viewToken) && (value.chatSessionId === undefined || typeof value.chatSessionId === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value.chatSessionId)) && Array.isArray(value.materials) && value.materials.every(row => row && (row.mode === undefined || row.mode === 'core' || row.mode === 'bank')) && (!value.session || value.session.mode === undefined || value.session.mode === 'core' || value.session.mode === 'bank') && (!value.launch || value.launch.id === planId && typeof value.launch.title === 'string' && typeof value.launch.available === 'boolean' && Array.isArray(value.launch.materialIds) && value.launch.materialIds.every(id => typeof id === 'string') && (value.launch.mode === undefined || value.launch.mode === 'core' || value.launch.mode === 'bank')) && (value.studyTarget === undefined || validStudyTarget(value.studyTarget)) && Array.isArray(value.history) && validExerciseView(value.card); }
function sameStudyFrame(before, after) { return validView(after) && !!before && !!before.card && !!after.card && !!before.session && !!after.session && before.session.id === after.session.id && before.status === after.status && before.session.mode === after.session.mode && before.session.completed === after.session.completed && before.session.answers === after.session.answers && JSON.stringify(before.card) === JSON.stringify(after.card); }
function rememberServerClock(value) { serverClock = {time:Number.isSafeInteger(value.serverNow) ? value.serverNow : Date.now(),at:performance.now()}; if (Number.isSafeInteger(value.connectionExpiresAt) && value.connectionExpiresAt > 0) connectionExpiresAt = Math.min(value.connectionExpiresAt,connectionHardExpiresAt || value.connectionExpiresAt); }
function serverTime() { return serverClock ? serverClock.time+performance.now()-serverClock.at : Date.now(); }
function waitingRemaining() { const until = current && current.session && current.session.waitUntil; return Number.isSafeInteger(until) ? Math.max(0,until-serverTime()) : 0; }
function endConnection() {
  persistDraft(); contextGeneration++; locked = true; clearError(); clearTimeout(lifetimeTimer); clearTimeout(waitingTimer); clearTimeout(lessonTimer); clearTimeout(resumeTimer); resumeNeeded = false;
  cancelOrderInteraction(); closeFilterPicker(); releaseMedia(); vaultDrafts.clear(); cardDom = null; waitingDom = null;
  const section = landing('Подключение завершено','Закройте это окно и снова откройте занятие кнопкой бота. Уже сохранённые оценки останутся в истории.'), closeWindow = button('Закрыть окно',close,'ar-primary');
  closeWindow.dataset.localAction = 'true'; section.append(closeWindow); root.replaceChildren(section); announce('Подключение завершено. Откройте занятие заново из чата бота.'); setBusy(false);
}
function sessionDeadline() { const session = current && current.session; return session && ['question','result','waiting'].includes(current.status) && Number.isSafeInteger(session.idleExpiresAt) ? session.idleExpiresAt : Infinity; }
function updateSessionTimer() {
  clearTimeout(lessonTimer); if (!sessionTimerDom || !sessionTimerDom.section.isConnected || !current || !current.session || locked) return;
  const session = current.session, paused = current.status === 'paused', end = paused ? Number.isSafeInteger(session.pausedAt) ? session.pausedAt : serverClock.time : serverTime();
  const elapsed = Math.max(0,Math.floor((end-session.startedAt-(session.pausedDurationMs || 0))/1000)), limit = Math.min(90,session.timeLimitMinutes || 90)*60;
  sessionTimerDom.remaining.textContent = durationText(Math.max(0,limit-elapsed));
  sessionTimerDom.section.dataset.paused = String(paused);
  if (!paused && document.visibilityState !== 'hidden' && !(tg && tg.isActive === false)) lessonTimer = setTimeout(updateSessionTimer,1000);
}
function sessionTimerView() {
  if (picker || !current.session || !Number.isSafeInteger(current.session.startedAt) || !['question','result','waiting','paused'].includes(current.status)) return null;
  const section = el('section','ar-session-timer'), cell = el('div'), remaining = el('span','ar-session-remaining'); section.setAttribute('aria-label','Время занятия');
  remaining.setAttribute('role','timer'); remaining.setAttribute('aria-live','off'); remaining.setAttribute('aria-label','Осталось учебного времени'); cell.append(el('span','ar-session-time-label','Осталось'),remaining); section.append(cell);
  sessionTimerDom = {section,remaining}; return section;
}
function scheduleSessionExpiry() {
  clearTimeout(lifetimeTimer); if (locked || !current || document.visibilityState === 'hidden' || tg && tg.isActive === false) return;
  const until = Math.min(connectionExpiresAt || Infinity, sessionDeadline()), remaining = until-serverTime(); if (!Number.isFinite(remaining)) return;
  lifetimeTimer = setTimeout(() => { if (connectionExpiresAt && serverTime() >= connectionExpiresAt) endConnection(); else { resumeNeeded = true; void refreshOnResume(); } },Math.max(0,remaining));
}
function updateWaitingCountdown() {
  clearTimeout(waitingTimer); if (!waitingDom || !waitingDom.timer.isConnected || !current || current.status !== 'waiting') return;
  const remaining = waitingRemaining(), seconds = Math.ceil(remaining/1000), minutes = Math.floor(seconds/60);
  waitingDom.timer.textContent = String(minutes).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');
  waitingDom.description.textContent = remaining ? 'До следующего повтора' : 'Можно продолжить повторение.';
  waitingDom.continue.textContent = remaining && current.session.canContinueEarly ? 'Продолжить сейчас' : 'Продолжить';
  waitingDom.continue.dataset.unavailable = String(remaining > 0 && !current.session.canContinueEarly);
  waitingDom.compatibility.hidden = !remaining || current.session.canContinueEarly === true;
  waitingDom.continue.disabled = busy || locked || !!pending || waitingDom.continue.dataset.unavailable === 'true';
  if (remaining && document.visibilityState !== 'hidden' && !(tg && tg.isActive === false)) waitingTimer = setTimeout(updateWaitingCountdown,Math.min(1000,remaining));
}
function rememberQuietView(value) { current = value; rememberServerClock(value); scheduleSessionExpiry(); updateSessionTimer(); if (value.launch) launch = value.launch; if (cardDom && value.answerHistorySupported === true) cardDom.retentionInput.checked = value.retainAnswers === true; if (!retainDraft() && localState.available()) void localState.clearDraft(); }
function sameWaitingFrame(before,after) { return validView(after) && before && before.status === 'waiting' && after.status === 'waiting' && before.session && after.session && before.session.id === after.session.id && before.session.waitUntil === after.session.waitUntil && before.session.canContinueEarly === after.session.canContinueEarly && before.session.completed === after.session.completed && before.session.answers === after.session.answers; }
function samePausedFrame(before,after) { return validView(after) && before && before.status === 'paused' && after.status === 'paused' && before.session && after.session && before.session.id === after.session.id && before.session.pausedAt === after.session.pausedAt && before.session.completed === after.session.completed && before.session.answers === after.session.answers && JSON.stringify(before.card || null) === JSON.stringify(after.card || null); }
function markSuspended() { cancelOrderInteraction(); persistDraft(); resumeNeeded = true; clearTimeout(resumeTimer); clearTimeout(waitingTimer); clearTimeout(lifetimeTimer); clearTimeout(lessonTimer); closeFilterPicker(); }
function scheduleResume(force) { if (force) resumeNeeded = true; clearTimeout(resumeTimer); if (!resumeNeeded || document.visibilityState === 'hidden' || tg && tg.isActive === false) return; if (connectionExpiresAt && serverTime() >= connectionExpiresAt) { endConnection(); return; } updateWaitingCountdown(); updateSessionTimer(); scheduleSessionExpiry(); if (current && current.status === 'paused') { resumeNeeded = false; return; } resumeTimer = setTimeout(refreshOnResume,180); }
async function refreshOnResume() {
  if (!resumeNeeded || resumeReading || busy || pending || locked || !current || current.status === 'paused' || !bearer || document.visibilityState === 'hidden' || tg && tg.isActive === false) return;
  resumeNeeded = false; const before = current, top = scrollY, left = scrollX, request = sectionView === 'today' ? {kind:'today'} : viewRequest();
  const reading = post('/miniapp/study',request,true); resumeReading = reading;
  try { const value = await reading; if (locked || busy || pending || current !== before) return; if (!validView(value) || value.today !== undefined && !validToday(value.today)) throw failure(0);
    if (sectionView === 'study' && !picker && cardDom && sameStudyFrame(before,value)) { rememberQuietView(value); clearError(); }
    else { const changedCard = sectionView === 'study' && !!before.card && !!before.session && !sameStudyFrame(before,value); if (request.kind === 'today') { today = value.today === undefined ? null : value.today; week = value.week === undefined ? null : value.week; } accept(value,false,picker); window.scrollTo(left,top); if (changedCard && value.status !== 'finished') error('Занятие изменилось','Карточка или её состояние изменились. Проверьте обновлённый экран перед ответом.',null); else clearError(); }
  } catch (problem) { if (!locked && !busy && !pending && current === before && (problem.status === 401 || problem.status === 403 || serverTime() >= sessionDeadline())) { handleFailure(problem,() => loadView()); updateDisabled(); } }
  finally { if (resumeReading === reading) resumeReading = null; if (resumeNeeded) scheduleResume(); }
}
async function postPending() {
  let rebased = false;
  for (;;) { try { return await post('/miniapp/study',pending,true); }
    catch (problem) { if (problem.status !== 409 || rebased || !['check','self-recall','reveal','hint','grade','next','skip','resume'].includes(pending.kind)) throw problem;
      const before = current, fresh = await post('/miniapp/study',viewRequest(),true);
      const unchanged = pending.kind === 'resume' ? samePausedFrame(before,fresh) : sameStudyFrame(before,fresh) || pending.kind === 'next' && sameWaitingFrame(before,fresh);
      if (!unchanged) { problem.freshView = fresh; throw problem; }
      rememberQuietView(fresh); if (pending.kind === 'grade') { delete pending.text; delete pending.response; Object.assign(pending,answerHistoryFields(fresh.card)); } pending = Object.assign({},pending,{requestId:crypto.randomUUID(),viewToken:fresh.viewToken}); rebased = true;
    }
  }
}
function accept(value, entry, pickMaterials) { if (locked) return; cancelOrderInteraction(); if (!validView(value) || value.today !== undefined && !validToday(value.today) || value.week !== undefined && !validToday(value.week)) throw failure(0); const previousKey = draft.key, wasPaused = current && current.status === 'paused'; current = value; rememberServerClock(value); if (value.launch) launch = value.launch; if (value.today) today = value.today; if (value.week) week = value.week; picker = !!pickMaterials && value.status !== 'chat-active' || !!startConflict || planChoosing && value.status !== 'chat-active' || value.status === 'finished' && (!!entry || picker); editingGrade = false; const key = value.card && value.session ? value.session.id + ':' + value.card.id + ':' + value.card.revision : '';
  const notice = $('window-status'); if (value.answerHistoryWarning) { notice.textContent = value.answerHistoryWarning; notice.hidden = false; notice.dataset.noticeKind = 'answer-history'; announce(value.answerHistoryWarning); } else if (notice.dataset.noticeKind === 'answer-history') { notice.hidden = true; delete notice.dataset.noticeKind; }
  ['core','bank'].forEach(mode => { const available = new Set(value.materials.filter(row => modeOf(row) === mode && row.count > 0).map(row => row.id)); selectedMaterials(mode).forEach(id => { if (!available.has(id)) selectedMaterials(mode).delete(id); }); });
  if (!settingsPrepared && value.defaults) { ['core','bank'].forEach(mode => { const values = value.defaults[mode]; if (values) ['cardLimit','timeLimitMinutes'].forEach(key => { startSettings[mode][key] = Number.isSafeInteger(values[key]) && values[key] > 0 ? String(key === 'timeLimitMinutes' ? Math.min(90,values[key]) : values[key]) : ''; }); }); settingsPrepared = true; }
  if (!planChoosing && value.session && value.session.mode && (!startConflict && ['question','result','waiting','paused'].includes(value.status) || entry && value.status === 'finished')) studyMode = value.session.mode;
  if (planChoosing && launch && !planPrepared) { ['core','bank'].forEach(mode => { selectedMaterials(mode).clear(); pickerMaterials(mode).filter(row => row.count > 0).forEach(row => selectedMaterials(mode).add(row.id)); }); studyMode = launch.mode || (pickerMaterials('core').some(row => row.count > 0) ? 'core' : pickerMaterials('bank').some(row => row.count > 0) ? 'bank' : 'core'); planPrepared = launch.available; }
    if (key !== previousKey) { releaseMedia(true); draft = {key,selected:[],text:'',blanks:[],matches:[],order:[]}; recoveredDraft = ''; cardDom = null; historySize = 20;
    if (retainDraft() && ['question','paused'].includes(value.status) && value.card && !value.card.result && !value.card.selectedRating) { const restored = localState.restoreDraft(Object.assign({key},value.card)); if (restored) { draft = restored; recoveredDraft = key; announce('Незавершённый ответ восстановлен на этом устройстве.'); } }
  }
  if (value.card && (value.card.result || value.card.selectedRating) || ['materials','finished','unavailable','chat-active'].includes(value.status)) vaultDrafts.delete(storageScope);
  if (!retainDraft() || value.card && (value.card.result || value.card.selectedRating) || ['materials','finished','unavailable','chat-active'].includes(value.status)) { recoveredDraft = ''; if (localState.available()) void localState.clearDraft(); }
  if (value.card && value.card.result && value.card.result.feedback && value.card.result.feedback.kind === 'choice') draft.selected = value.card.result.feedback.selectedOptionIndexes.slice();
  if (value.card && value.card.result && value.card.result.feedback && value.card.result.feedback.kind === 'matching') draft.matches = value.card.result.feedback.matches.slice();
  if (value.card && value.card.result && value.card.result.feedback && value.card.result.feedback.kind === 'ordering') draft.order = value.card.result.feedback.order.slice();
  render(entry && value.status === 'finished'); scheduleSessionExpiry(); if (wasPaused !== (value.status === 'paused')) { const nextFocus = value.status === 'paused' ? root.querySelector('.ar-paused button') : root.querySelector('textarea,input,[role=combobox],.ar-order-item') || root; if (busy) busyFocus = nextFocus; else if (nextFocus && !nextFocus.disabled) nextFocus.focus({preventScroll:true}); } if (key !== previousKey) { window.scrollTo(0, 0); root.focus({preventScroll:true}); }
}
async function loadView() { if (busy || locked || pending) return; clearError(); setBusy(true, 'Обновляем занятие…'); try { accept(await post('/miniapp/study', viewRequest(), true),true); } catch (problem) { handleFailure(problem, () => loadView()); } finally { setBusy(false); } }
async function loadToday() { if (busy || locked || pending) return; clearError(); setBusy(true,'Загружаем учебный план…'); try { const value = await post('/miniapp/study',{kind:'today'},true); if (!validView(value) || value.today !== undefined && !validToday(value.today) || value.week !== undefined && !validToday(value.week)) throw failure(0); today = value.today === undefined ? null : value.today; week = value.week === undefined ? null : value.week; sectionView = 'today'; accept(value); } catch (problem) { handleFailure(problem,() => loadToday()); } finally { setBusy(false); } }
async function openPlan(id, immediate) {
  if (busy || locked || pending || typeof id !== 'string' || id.length !== 64 || !/^[a-f0-9]{64}$/.test(id)) return;
  clearError(); setBusy(true,'Открываем занятие по плану…'); const previousId = planId; let startPrepared;
  try {
    const value = await post('/miniapp/study',{kind:'plan',id},true); planId = id;
    if (!validView(value) || !value.launch) { planId = previousId; throw failure(0); }
    planChoosing = true; planPrepared = false; planContinued = false; startConflict = ''; sectionView = 'study';
    history.replaceState(null,'','/miniapp/?plan=' + id); accept(value);
    if (immediate && value.studyTarget && value.studyTarget.id === id && canRepeatStudyTarget(value.studyTarget) && value.launch.available && value.launch.mode === 'core' && !unfinished() && value.status !== 'chat-active') {
      const fields = sessionLimitFields('core');
      const materialIds = value.materials.filter(row => row.mode !== 'bank' && row.count > 0 && value.launch.materialIds.includes(row.id)).map(row => row.id);
      if (fields && materialIds.length) startPrepared = Object.assign({materialIds,mode:'core',shuffle:shuffleCards},fields);
    }
  } catch (problem) { handleFailure(problem,() => openPlan(id,immediate)); } finally { setBusy(false); }
  if (startPrepared) act('start',startPrepared);
}
async function sendPending() { if (busy || locked || !pending) return; clearError(); setBusy(true, pending.kind === 'report-card' ? 'Сохраняем отметку для разбора…' : pending.kind === 'plan-action' ? 'Сохраняем изменение плана…' : pending.kind === 'pause' ? 'Ставим занятие на паузу…' : pending.kind === 'resume' ? 'Продолжаем занятие…' : pending.kind === 'finish-chat' ? 'Завершаем занятие в чате…' : pending.kind === 'grade' || pending.kind === 'change-grade' ? 'Сохраняем оценку…' : 'Обновляем занятие…');
  try { const value = await postPending(); if (!validView(value)) throw failure(0); const completed = pending; if (pending.kind !== 'finish') startConflict = ''; if (completed.kind === 'start' && planChoosing) { planChoosing = false; planContinued = false; } pending = null; resumeNeeded = false; if (completed.kind === 'report-card') { cardReportEdits.set(draft.key,{reason:'',note:'',open:true}); announce('Отметка сохранена в Telegram. Подтверждение появится после подключения Obsidian.'); } if (completed.kind === 'plan-action') planEdits.delete(completed.id); accept(value,false,completed.kind === 'finish-chat'); if (completed.kind === 'plan-action') announce('Изменение плана сохранено. Подтверждение появится после подключения Obsidian.'); if (completed.kind === 'pause') announce('Занятие на паузе. Таймер остановлен.'); if (completed.kind === 'resume') announce('Занятие продолжено.'); if (completed.kind === 'finish-chat') announce(value.status === 'chat-active' ? 'В чате открыто другое занятие.' : 'Занятие в чате завершено. Выставленные оценки сохранены.'); if (completed.kind === 'grade') announce('Оценка «' + labels[completed.rating] + '» сохранена. ' + (value.status === 'finished' ? value.session && value.session.mode === 'bank' ? 'Практика завершена.' : 'Занятие завершено.' : value.status === 'waiting' ? 'Ожидаем короткий повтор.' : 'Следующая карточка.')); }
  catch (problem) { if (problem.status === 409) { const failedStart = preserveFailedStart(), finishingPrevious = pending.kind === 'finish' && !!startConflict, finishingChat = pending.kind === 'finish-chat'; if (!failedStart && !finishingPrevious) startConflict = ''; pending = null;
      if (failedStart) { picker = true; render(); }
      try { const fresh = problem.freshView || await post('/miniapp/study', sectionView === 'today' ? {kind:'today'} : viewRequest(), true); accept(fresh,true); if (fresh.status === 'finished') clearError(); else error(failedStart ? 'Занятие не запущено' : finishingChat ? 'Занятие изменилось' : 'Экран обновлён', failedStart ? 'Занятие «' + startConflict + '» не запущено. Данные изменились. Выберите материал ещё раз.' : finishingChat ? 'Обновили экран. Проверьте занятие и повторите завершение, если нужно.' : finishingPrevious ? 'Прежнее занятие не завершено. Данные изменились. Выберите действие ещё раз.' : 'Данные изменились. Проверьте текущую карточку перед следующим действием.', null); } catch (freshError) { handleFailure(freshError, () => loadView()); } }
    else if (problem.status === 400 && pending) { const failedStart = preserveFailedStart(); pending = null;
      try { const fresh = await post('/miniapp/study',viewRequest(),true); accept(fresh,true); if (fresh.status === 'finished') clearError(); else error(failedStart ? 'Занятие не запущено' : 'Действие недоступно',failedStart ? 'Проверьте выбранные материалы и попробуйте снова.' : 'Обновили занятие. Проверьте текущую карточку перед следующим действием.',() => loadView()); } catch (freshError) { handleFailure(freshError,() => loadView()); }
    } else handleFailure(problem, () => sendPending()); }
  finally { setBusy(false); }
}
function act(kind, fields) { if (busy || locked || pending || !current) return; if (connectionExpiresAt && serverTime() >= connectionExpiresAt) { endConnection(); return; } if (kind !== 'finish' && serverTime() >= sessionDeadline()) { resumeNeeded = true; void refreshOnResume(); return; } if (kind === 'start' && planChoosing && launch && planId) fields = Object.assign({},fields || {},{planId}); if (kind === 'start' && (unfinished() || planChoosing && (!launch || !launch.available || !fields || !fields.materialIds.length || fields.materialIds.some(id => !(fields.planId ? targetMaterials(fields.mode) : pickerMaterials(fields.mode)).some(row => row.id === id && row.count > 0))))) return; pending = Object.assign({kind,requestId:crypto.randomUUID(),viewToken:current.viewToken}, fields || {}); sendPending(); }
async function authenticate() {
  if (busy) return; clearError(); locked = false;
  if (invalidVaultLink) { locked = true; root.replaceChildren(landing('Ссылка хранилища недействительна','Откройте занятие новой кнопкой в Telegram.')); return; }
  if (!tg || typeof tg.initData !== 'string' || !tg.initData) { locked = true; $('close').hidden = !tg; root.replaceChildren(landing('Занятие в Telegram','Откройте этот экран кнопкой в чате бота.')); error('Откройте экран из Telegram', 'Воспользуйтесь кнопкой занятия в чате бота. Ссылка из обычного браузера не подключает материалы.', null); return; }
  contextGeneration++;
  setBusy(true, 'Подключаемся к Telegram…');
  try { const requested = vaultId || launchVaultId, result = readVaultAuth(await post('/miniapp/auth', Object.assign({initData:tg.initData},requested ? {vaultId:requested} : planId ? {planId} : {}), false)); if (!result || requested && result.vaultId !== requested) throw failure(0); bearer = result.token; vaultId = result.vaultId || ''; vaults = result.vaults; storageScope = result.storageScope || ''; connectionExpiresAt = result.expiresAt; connectionHardExpiresAt = result.expiresAt; await localState.bind(result.storageScope); accept(await post('/miniapp/study', viewRequest(), true),true); }
  catch (problem) { if ([401,403].includes(problem.status) && (vaultId || launchVaultId || planId)) { locked = true; root.replaceChildren(landing('Ссылка на занятие недоступна','Откройте новое занятие или учебный план кнопкой в Telegram.')); error('Ссылка на занятие недоступна','Подключение или учебный план могли измениться. Откройте новую кнопку бота.',null); } else handleFailure(problem, () => authenticate()); } finally { setBusy(false); }
}
function resetVaultView(nextScope) {
  cancelOrderInteraction(); closeFilterPicker(); releaseMedia();
  [lifetimeTimer,waitingTimer,lessonTimer,resumeTimer].forEach(clearTimeout); resumeNeeded = false; resumeReading = null;
  current = null; cardDom = null; waitingDom = null; sessionTimerDom = null; serverClock = null;
  const remembered = vaultDrafts.get(nextScope); vaultDrafts.delete(nextScope); draft = remembered ? JSON.parse(JSON.stringify(remembered)) : {key:'',selected:[],text:'',blanks:[],matches:[],order:[]};
  recoveredDraft = remembered ? remembered.key : ''; historySize = 20; editingGrade = false; historyOpen = false;
  selectedPreset = ''; presetName = ''; presetFeedback = ''; presetsOpen = false; presetRefresh = null;
  picker = false; startConflict = ''; shuffleCards = false; studyMode = 'core'; settingsPrepared = false;
  planId = ''; launch = null; planPrepared = false; planChoosing = false; planContinued = false; sectionView = 'study'; today = null; week = null; planRange = 'today';
  planEdits.clear(); cardReportEdits.clear(); topicRecallExpanded = false; topicRecallSelected = ''; studyTargetExpanded = true;
  ['core','bank'].forEach(mode => { materialSelections[mode].clear(); settingsOpen[mode] = false; startSettings[mode] = {cardLimit:'',timeLimitMinutes:''}; Object.keys(studyFilters[mode]).forEach(key => { studyFilters[mode][key] = ''; }); });
}
async function switchVault(id) {
  if (busy || pending || locked || id === vaultId || !vaults.some(row => row.id === id)) return;
  if (connectionExpiresAt && serverTime() >= connectionExpiresAt) { endConnection(); return; }
  clearError(); setBusy(true,'Переключаем хранилище…'); contextGeneration++;
  const generation = contextGeneration, hardExpiry = connectionHardExpiresAt;
  try {
    vaultDrafts.delete(storageScope);
    if (storageScope && current && ['question','paused'].includes(current.status) && current.card && !current.card.result && !current.card.selectedRating && draft.key) vaultDrafts.set(storageScope,JSON.parse(JSON.stringify(draft)));
    persistDraft(); await localState.flush();
    const result = readVaultAuth(await post('/miniapp/vault',{vaultId:id},true));
    if (!result || result.vaultId !== id) throw failure(0);
    const value = await post('/miniapp/study',{kind:'view'},true,result.token);
    if (!validView(value) || value.today !== undefined && !validToday(value.today) || value.week !== undefined && !validToday(value.week)) throw failure(0);
    resetVaultView(result.storageScope); bearer = result.token; vaultId = result.vaultId; vaults = result.vaults; storageScope = result.storageScope;
    connectionHardExpiresAt = Math.min(hardExpiry || result.expiresAt,result.expiresAt); connectionExpiresAt = connectionHardExpiresAt;
    await localState.bind(storageScope); if (generation !== contextGeneration) return;
    accept(value,true); try { const url = new URL(location.href), fragment = new URLSearchParams(url.hash.slice(1)); url.searchParams.delete('plan'); fragment.set('vault',vaultId); url.hash = fragment.toString(); history.replaceState(null,'',url); } catch (_) {}
    announce('Открыто хранилище «' + vaults.find(row => row.id === vaultId).name + '».');
  } catch (problem) {
    if (generation !== contextGeneration) return;
    error('Не удалось переключить хранилище',[400,401,403].includes(problem.status) ? 'Хранилище недоступно. Текущие материалы и ответ не изменены. Проверьте подключение в Obsidian.' : 'Проверьте соединение и повторите попытку. Текущие материалы и ответ не изменены.',() => switchVault(id));
  } finally { if (generation === contextGeneration) { setBusy(false); const picker = root.querySelector('#ar-vault'); if (picker && !locked) picker.focus({preventScroll:true}); } }
}
function updateCheck() { if (!cardDom || !current || !current.card) return; const card = current.card; let complete = card.kind === 'single' || card.kind === 'multiple' ? draft.selected.length > 0 : card.kind === 'cloze' ? draft.blanks.length === card.blankCount && draft.blanks.every(text => text.trim().length > 0) : card.kind === 'matching' ? permutation(draft.matches,card.matching.left.length) : card.kind === 'ordering' ? permutation(draft.order,card.orderItems.length) : draft.text.trim().length > 0;
  cardDom.check.disabled = busy || locked || !!pending || !complete; }
function createOrderInput(list, card) {
  const rows = new Map(), help = el('p','ar-sr','Перетаскивайте за всю строку. С клавиатуры: пробел или Enter — взять и положить, стрелки вверх и вниз — переместить, Home и End — в начало и конец, Escape — отменить.');
  help.id = 'ar-order-help'; list.before(help); list.setAttribute('aria-describedby',help.id);
  let pointer = null, keyboard = null, frame = 0, lastFrame = 0, reordering = false;
  const available = () => !busy && !locked && !pending && current && current.status === 'question' && current.card && current.card.id === card.id && current.card.revision === card.revision && !current.card.result;
  const orderRows = order => { const focused = list.contains(document.activeElement) ? document.activeElement : null; reordering = true; order.forEach((item,index) => { const row = rows.get(item); if (list.children[index] !== row) list.insertBefore(row,list.children[index] || null); row.querySelector('.ar-order-number').textContent = String(index + 1); row.setAttribute('aria-posinset',String(index + 1)); }); reordering = false; if (focused && focused.isConnected) focused.focus({preventScroll:true}); };
  const report = item => announce('Позиция ' + (draft.order.indexOf(item) + 1) + ' из ' + draft.order.length + '. ' + card.orderItems[item]);
  const finish = (commit, focus) => {
    const drag = pointer, key = keyboard; if (!drag && !key) return;
    pointer = null; keyboard = null; cancelAnimationFrame(frame); frame = 0; lastFrame = 0;
    if (drag) { if (drag.row.hasPointerCapture(drag.id)) drag.row.releasePointerCapture(drag.id); drag.row.classList.remove('is-dragging'); drag.row.style.removeProperty('width'); if (drag.preview) drag.preview.remove(); if (drag.placeholder) drag.placeholder.remove(); document.body.classList.remove('ar-order-dragging'); }
    if (key) rows.get(key.item).classList.remove('is-keyboard-dragging');
    document.removeEventListener('keydown',escape,true); window.removeEventListener('resize',cancel); if (window.visualViewport) visualViewport.removeEventListener('resize',cancel);
    const item = drag ? drag.item : key.item;
    if (commit && available()) { if (drag && drag.active) { const next = draft.order.filter(value => value !== item); next.splice(drag.target,0,item); draft.order = next; } else if (key) draft.order = key.order.slice(); persistDraft(); }
    orderRows(draft.order); updateCheck();
    if (focus && rows.get(item).isConnected) rows.get(item).focus({preventScroll:true});
    if (commit) report(item); else if (drag && drag.active || key) announce('Перемещение отменено. ' + card.orderItems[item]);
  };
  const cancel = () => finish(false,false), escape = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false,true); } };
  const listen = () => { document.addEventListener('keydown',escape,true); window.addEventListener('resize',cancel); if (window.visualViewport) visualViewport.addEventListener('resize',cancel); };
  const inside = drag => { const box = list.getBoundingClientRect(); return drag.x >= box.left && drag.x <= box.right && drag.y >= box.top && drag.y <= box.bottom && drag.x >= 0 && drag.x <= innerWidth && drag.y >= 0 && drag.y <= innerHeight; };
  const position = drag => {
    const outside = !inside(drag); drag.outside = outside; drag.preview.classList.toggle('is-outside',outside);
    const box = drag.preview.getBoundingClientRect(), viewport = window.visualViewport, left = viewport ? viewport.offsetLeft : 0, top = viewport ? viewport.offsetTop : 0, width = viewport ? viewport.width : innerWidth, height = viewport ? viewport.height : innerHeight;
    drag.preview.style.left = Math.max(left + 8,Math.min(drag.x - drag.offsetX,left + width - box.width - 8)) + 'px'; drag.preview.style.top = Math.max(top + 8,Math.min(drag.y - drag.offsetY,top + height - box.height - 8)) + 'px';
    if (outside) return;
    const y = drag.y + scrollY - (list.getBoundingClientRect().top + scrollY - drag.listTop); let target = drag.slots.findIndex(slot => y < slot.center); if (target < 0) target = drag.slots.length;
    if (target === drag.target) return; drag.target = target;
    if (target < drag.slots.length) rows.get(drag.slots[target].item).before(drag.placeholder); else list.append(drag.placeholder);
    drag.preview.querySelector('.ar-order-number').textContent = String(target + 1);
  };
  const tick = time => {
    const drag = pointer; if (!drag || !drag.active) return;
    if (!available() || !list.isConnected) { cancel(); return; }
    const elapsed = lastFrame ? Math.min(32,time-lastFrame) : 16; lastFrame = time;
    const viewport = window.visualViewport, top = viewport ? viewport.offsetTop : 0, bottom = top + (viewport ? viewport.height : innerHeight), box = list.getBoundingClientRect();
    if (drag.x >= box.left && drag.x <= box.right && drag.y >= Math.max(top,box.top-8) && drag.y <= Math.min(bottom,box.bottom+8)) { const speed = drag.y < top + 56 ? -Math.min(1,(top + 56-drag.y)/56) : drag.y > bottom - 56 ? Math.min(1,(drag.y-bottom+56)/56) : 0; if (speed) window.scrollBy(0,speed * elapsed * .55); }
    position(drag); frame = requestAnimationFrame(tick);
  };
  card.orderItems.forEach((text,item) => {
    const row = el('li','ar-order-item'), number = el('span','ar-order-number'), label = el('span','ar-literal ar-order-text',text); row.dataset.item = String(item); row.tabIndex = 0; row.setAttribute('aria-describedby',help.id); row.setAttribute('aria-setsize',String(card.orderItems.length)); number.setAttribute('aria-hidden','true'); row.append(number,label); rows.set(item,row); list.append(row);
    row.addEventListener('dragstart',event => event.preventDefault());
    row.addEventListener('pointerdown',event => { if (!event.isPrimary || event.button !== 0 || !available() || pointer || keyboard) return; const rect = row.getBoundingClientRect(); pointer = {id:event.pointerId,item,row,x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,offsetX:event.clientX-rect.left,offsetY:event.clientY-rect.top,target:draft.order.indexOf(item),active:false}; row.focus({preventScroll:true}); row.setPointerCapture(event.pointerId); listen(); });
    row.addEventListener('pointermove',event => {
      const drag = pointer; if (!drag || drag.id !== event.pointerId || drag.row !== row) return; drag.x = event.clientX; drag.y = event.clientY;
      if (!drag.active) { if (Math.hypot(drag.x-drag.startX,drag.y-drag.startY) < 8) return;
        const rect = row.getBoundingClientRect(); drag.listTop = list.getBoundingClientRect().top + scrollY; drag.slots = draft.order.filter(value => value !== item).map(value => { const box = rows.get(value).getBoundingClientRect(); return {item:value,center:box.top + scrollY + box.height/2}; });
        drag.placeholder = el('li','ar-order-placeholder'); drag.placeholder.setAttribute('aria-hidden','true'); drag.placeholder.style.height = rect.height + 'px'; row.before(drag.placeholder); row.style.width = rect.width + 'px'; row.classList.add('is-dragging');
        drag.preview = el('div','ar-order-item ar-order-preview'); drag.preview.setAttribute('aria-hidden','true'); drag.preview.style.width = Math.min(rect.width,innerWidth-16) + 'px'; drag.preview.append(el('span','ar-order-number',String(drag.target+1)),el('span','ar-literal ar-order-text',text)); document.body.append(drag.preview); document.body.classList.add('ar-order-dragging'); drag.active = true; frame = requestAnimationFrame(tick); announce('Выбрано для перемещения. ' + text);
      }
      event.preventDefault(); position(drag);
    });
    row.addEventListener('pointerup',event => { const drag = pointer; if (!drag || drag.id !== event.pointerId) return; drag.x = event.clientX; drag.y = event.clientY; if (drag.active) { event.preventDefault(); position(drag); } finish(drag.active && !drag.outside,true); });
    row.addEventListener('pointercancel',event => { if (pointer && pointer.id === event.pointerId) cancel(); }); row.addEventListener('lostpointercapture',event => { if (pointer && pointer.id === event.pointerId) cancel(); });
    row.addEventListener('keydown',event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing || pointer || !available()) return;
      if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (event.repeat) return; if (keyboard) finish(true,true); else { keyboard = {item,order:draft.order.slice()}; row.classList.add('is-keyboard-dragging'); listen(); announce('Выбрано для перемещения. ' + text); } return; }
      if (!keyboard || keyboard.item !== item) return;
      if (event.key === 'Tab') { finish(true,false); return; }
      if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); const from = keyboard.order.indexOf(item), to = event.key === 'Home' ? 0 : event.key === 'End' ? keyboard.order.length - 1 : from + (event.key === 'ArrowUp' ? -1 : 1); if (to < 0 || to >= keyboard.order.length || from === to) return;
      keyboard.order.splice(from,1); keyboard.order.splice(to,0,item); orderRows(keyboard.order); row.focus({preventScroll:true}); row.scrollIntoView({block:'nearest'}); announce('Позиция ' + (to+1) + ' из ' + keyboard.order.length + '. ' + text);
    });
    row.addEventListener('focusout',event => { if (!reordering && keyboard && keyboard.item === item && !row.contains(event.relatedTarget)) finish(true,false); });
  });
  return {cancel,render() { const enabled = !!available(); if (!enabled) cancel(); if (!pointer && !keyboard) orderRows(draft.order); rows.forEach(row => { row.setAttribute('aria-disabled',String(!enabled)); row.tabIndex = enabled ? 0 : -1; }); list.tabIndex = enabled ? 0 : -1; }};
}
function reportCardView() {
  if (current.cardReportsSupported !== true || !current.card) return null;
  const reasons = {'unclear-question':'Неясный вопрос','disputed-answer':'Сомнение в эталоне','too-much-information':'Слишком много информации','missing-context':'Не хватает контекста',other:'Другая причина'}, key = draft.key;
  if (!cardReportEdits.has(key)) cardReportEdits.set(key,{reason:'',note:'',open:false}); const edit = cardReportEdits.get(key), panel = el('details','ar-start-settings ar-card-report'), body = el('div','ar-stack'); panel.append(el('summary','','Нужно уточнить карточку')); panel.open = edit.open;
  panel.addEventListener('toggle',() => { if (panel.isConnected) edit.open = panel.open; });
  const report = (Array.isArray(current.cardReports) ? current.cardReports : []).filter(row => row.cardId === current.card.id).sort((a,b) => b.requestedAt-a.requestedAt)[0], waiting = report && report.status === 'pending';
  const reportLabels = {pending:'Отметка сохранена в Telegram; ожидает Obsidian.',applied:'Карточка отмечена для разбора в Obsidian.',conflict:'Карточка изменилась. Проверьте её перед новой отметкой.',missing:'Карточка больше недоступна в Obsidian.',revoked:'Разрешение на передачу карточки отозвано.',expired:'Срок действия отметки истёк. Обновите учебную копию.'};
  if (report) { const status = el('p','ar-empty',reportLabels[report.status] || 'Статус отметки пока недоступен.'); status.setAttribute('role','status'); body.append(status); }
  const reason = choicePicker('ar-card-report-reason','Причина',[{value:'',label:'Выберите причину'},...Object.entries(reasons).map(([value,label]) => ({value,label}))],edit.reason,value => { edit.reason = value; validate(); }), noteLabel = el('label','ar-field'), note = el('textarea'); note.maxLength = 4000; note.rows = 2; note.value = edit.note; noteLabel.append(el('span','','Заметка · необязательно'),note);
  const save = button('Отправить на разбор',() => { validate(); if (save.disabled) return; persistDraft(); act('report-card',{reason:edit.reason,...(edit.note.trim() ? {note:edit.note.trim()} : {})}); },'ar-ghost');
  const validate = () => { save.dataset.unavailable = String(!!waiting || !Object.prototype.hasOwnProperty.call(reasons,edit.reason) || edit.note.length > 4000); updateDisabled(); }; note.addEventListener('input',() => { edit.note = note.value; validate(); }); body.append(reason.field,noteLabel,el('p','ar-empty','Отметка передастся в Obsidian. Оценка и расписание карточки не изменятся.'),save); panel.append(body); validate(); return panel;
}
function answerHistoryFields(card) { if (!current || current.retainAnswers !== true) return {}; if (card.kind === 'self' || card.kind === 'exact') return {text:draft.text}; if ((card.kind === 'single' || card.kind === 'multiple') && !draft.selected.length || card.kind === 'cloze' && !draft.blanks.some(text => text.trim()) || card.kind === 'matching' && !draft.matches.some(value => value >= 0)) return {}; return {response:card.kind === 'single' || card.kind === 'multiple' ? {selectedOptionIndexes:draft.selected.slice()} : card.kind === 'cloze' ? {clozeAnswers:Array.from({length:card.blankCount},(_,index) => draft.blanks[index] || '')} : card.kind === 'matching' ? {matches:draft.matches.slice()} : {order:draft.order.slice()}}; }
function createCard() {
  const card = current.card, section = el('section','ar-section'), top = el('div'), meta = el('div','ar-meta'), progress = el('progress','ar-progress');
  const count = el('span'), kind = el('span','',kinds[card.kind] || 'Карточка'), mode = el('p','ar-session-mode'); meta.append(count, kind); progress.setAttribute('aria-label','Пройдено карточек'); top.append(mode,meta,progress);
  const heading = el('div'), material = el('p','ar-material',card.materialTitle), title = el('h1','ar-literal',card.question); heading.append(material,title);
  if (recoveredDraft === draft.key) heading.append(el('p','ar-empty ar-draft-recovered','Незавершённый ответ восстановлен на этом устройстве.'));
  const questionMedia = el('div','ar-media'), response = el('div','ar-stack'), options = el('fieldset','ar-options');
  options.append(el('legend','ar-sr','Варианты ответа'));
  if (card.kind === 'single' || card.kind === 'multiple') card.options.forEach((text,index) => { const row = el('label','ar-option'), input = el('input'); input.type = card.kind === 'single' ? 'radio' : 'checkbox'; input.name = 'answer-choice'; input.value = String(index); input.checked = draft.selected.includes(index);
    const status = el('span','ar-option-status'); row.append(input,el('span','ar-option-text',text),status); options.append(row);
    input.addEventListener('change', () => { draft.selected = card.kind === 'single' ? [index] : input.checked ? Array.from(new Set(draft.selected.concat(index))).sort((a,b) => a-b) : draft.selected.filter(value => value !== index); persistDraft(); updateCheck(); }); });
  const fields = [], matchPickers = [], orderList = el('ol','ar-order-list');
  if (card.kind === 'exact' || card.kind === 'cloze' || card.kind === 'self') { const count = card.kind === 'cloze' ? card.blankCount : 1; for (let index = 0; index < count; index++) { const label = el('label','ar-field'), input = el('textarea'); input.rows = card.kind === 'cloze' ? 1 : card.kind === 'self' ? 4 : 3; input.maxLength = card.kind === 'self' ? 4000 : 2000; input.autocomplete = 'off'; input.autocapitalize = 'off'; input.spellcheck = false; input.value = card.kind === 'cloze' ? draft.blanks[index] || '' : draft.text;
      if (card.kind === 'self') input.placeholder = 'Запишите своими словами — или ответьте устно';
      label.append(el('span','',card.kind === 'cloze' ? 'Пропуск ' + (index + 1) : card.kind === 'self' ? 'Ваш ответ по памяти' : 'Ваш ответ'),input); response.append(label); fields.push(input);
      input.addEventListener('input', () => { if (card.kind === 'cloze') draft.blanks = fields.map(field => field.value); else draft.text = input.value; persistDraft(); updateCheck(); }); } if (card.kind === 'cloze') response.classList.add('ar-cloze-fields'); }
  const matchEntries = index => [{value:'',label:'Выберите пару'},...card.matching.right.map((label,value) => ({value:String(value),label,disabled:draft.matches.some((chosen,other) => other !== index && chosen === value)}))];
  const refreshMatches = () => { matchPickers.forEach((picker,index) => picker.update(matchEntries(index),draft.matches[index] >= 0 ? String(draft.matches[index]) : '')); updateCheck(); };
  if (card.kind === 'matching') { if (draft.matches.length !== card.matching.left.length) draft.matches = card.matching.left.map(() => -1); card.matching.left.forEach((text,index) => { const picker = choicePicker('ar-match-' + index,text,matchEntries(index),draft.matches[index] >= 0 ? String(draft.matches[index]) : '',value => { draft.matches[index] = value === '' ? -1 : Number(value); persistDraft(); refreshMatches(); }); picker.field.classList.add('ar-matching-row'); response.append(picker.field); matchPickers.push(picker); }); }
  let orderControl = null;
  if (card.kind === 'ordering') { if (!permutation(draft.order,card.orderItems.length)) draft.order = card.orderItems.map((_,index) => index); orderList.tabIndex = 0; orderList.setAttribute('aria-label','Порядок элементов'); response.append(orderList); orderControl = createOrderInput(orderList,card); }
  const renderOrder = () => { if (orderControl) orderControl.render(); }, cancelOrder = () => { if (orderControl) orderControl.cancel(); };
  const hints = el('aside','ar-hint'), actions = el('div','ar-actions');
  const retention = el('label','ar-shuffle ar-answer-retention'), retentionInput = el('input'); retentionInput.type = 'checkbox'; retentionInput.checked = current.retainAnswers === true; retentionInput.setAttribute('aria-label','Сохранять ответы'); retention.title = 'Запоминается для всех следующих карточек и занятий. Правильные шаблонные ответы сохраняются без копии введённого текста. Выключение не удаляет прежнюю историю.'; retention.append(retentionInput,el('span','','Сохранять ответы')); retentionInput.addEventListener('change',() => { const enabled = retentionInput.checked; if (!enabled && localState.available()) void localState.clearDraft(); act('answer-retention',{enabled}); });
  const submitCheck = () => { if (check.disabled || !check.isConnected || check.closest('[hidden]')) return; const response = card.kind === 'single' || card.kind === 'multiple' ? {selectedOptionIndexes:draft.selected.slice()} : card.kind === 'cloze' ? {clozeAnswers:fields.map(field => field.value)} : card.kind === 'matching' ? {matches:draft.matches.slice()} : card.kind === 'ordering' ? {order:draft.order.slice()} : {text:draft.text}; act('check',{response}); };
  const check = button('Проверить ответ',submitCheck,'ar-primary');
  const checkOnEnter = event => { if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.keyCode === 229) return; event.preventDefault(); if (!event.repeat) submitCheck(); };
  if (card.kind !== 'self') fields.forEach(input => { input.title = 'Enter — проверить, Shift+Enter — новая строка'; input.addEventListener('keydown',checkOnEnter); });
  orderList.addEventListener('keydown',event => { if (event.target === orderList) checkOnEnter(event); });
  const secondary = el('div','ar-secondary'), hint = button('Подсказка',() => act('hint'),'ar-ghost'), reveal = button(card.kind === 'self' ? 'Сравнить с эталоном' : 'Показать ответ',() => card.kind === 'self' ? act('self-recall',{text:draft.text}) : act('reveal'),'ar-ghost'); secondary.append(hint,reveal); actions.append(check,secondary);
  if (card.kind === 'self') { check.hidden = true; reveal.className = 'ar-primary'; secondary.className = 'ar-stack'; }
  const feedback = el('section','ar-feedback'), answerMedia = el('div','ar-media'), source = el('details','ar-source-context'), grading = el('section','ar-grading'), selectedGrade = el('div','ar-grade-selected'), report = el('div');
  const next = button('Следующая карточка',() => act('next'),'ar-primary');
  section.append(top,heading,questionMedia,options,response,retention,hints,actions,feedback,answerMedia,source,grading,selectedGrade,report,next);
  cardDom = {section,count,mode,progress,questionMedia,options,response,retention,retentionInput,fields,matchPickers,refreshMatches,renderOrder,cancelOrder,hints,actions,check,hint,feedback,answerMedia,source,grading,selectedGrade,report,next,checkedCriteria:[]};
  return section;
}
function gradeButtons(ratings, work, shortcuts) { const group = el('div','ar-grades'); ratings.forEach(rating => { const node = button(labels[rating], () => work(rating)); node.dataset.rating = String(rating); if (shortcuts) { const key = el('kbd','ar-grade-key',String(rating)); key.setAttribute('aria-hidden','true'); node.prepend(key); node.setAttribute('aria-keyshortcuts',String(rating)); node.title = rating + ' — ' + labels[rating]; } group.append(node); }); return group; }
function recallComparison(answer, reference, criteria) { const suffix = Array.isArray(criteria) && criteria.length ? '\n\nКритерии самопроверки:\n' + criteria.map(text => '• ' + text).join('\n') : ''; const shownReference = suffix && reference.endsWith(suffix) ? reference.slice(0,-suffix.length) : reference; const comparison = el('div','ar-recall-comparison'); for (const [heading,text] of [['Ваш ответ по памяти',answer || 'Устный ответ — без записи.'],['Эталон',shownReference]]) { const column = el('section','ar-recall-column'); column.append(el('h3','',heading),el('p','ar-literal',text)); comparison.append(column); } return comparison; }
function recallCriteria(criteria, checked, change) { const list = el('fieldset','ar-recall-criteria'); list.append(el('legend','',change ? 'Что удалось вспомнить' : 'Отмеченные критерии')); criteria.forEach((text,index) => { const row = el('label','ar-option'), input = el('input'); input.type = 'checkbox'; input.checked = checked.includes(index); if (change) input.addEventListener('change',() => change(index,input.checked)); else input.dataset.unavailable = 'true'; row.append(input,el('span','ar-option-text',text)); list.append(row); }); return list; }
function gradeOnNumber(event) {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !/^[1-4]$/.test(event.key) || busy || locked || pending || picker || sectionView !== 'study' || !current || !current.card || !current.card.result || !cardDom || !cardDom.grading.isConnected || cardDom.grading.hidden) return;
  const target = event.target;
  if (target instanceof Element && (target.isContentEditable || !target.matches('.ar-recall-criteria input') && target.closest('input,textarea,select,[role="combobox"],[role="listbox"],[contenteditable]:not([contenteditable="false"]),audio,video,.ar-attachment,.ar-history,.ar-order-list'))) return;
  const control = cardDom.grading.querySelector('button[data-rating="' + event.key + '"]');
  if (control && !control.disabled) { event.preventDefault(); control.click(); }
}
function updateCard() {
  const card = current.card, result = card.result, d = cardDom, session = current.session;
  d.retention.hidden = current.answerHistorySupported !== true || !!card.selectedRating; d.retentionInput.checked = current.retainAnswers === true;
  d.mode.textContent = modeLabel(session && session.mode || studyMode);
  d.count.textContent = session ? 'Пройдено ' + session.completed + ' из ' + session.total : 'Карточка'; d.progress.max = session && session.total || 1; d.progress.value = session && session.completed || 0;
  d.options.hidden = card.kind !== 'single' && card.kind !== 'multiple'; d.response.hidden = !['exact','cloze','matching','ordering','self'].includes(card.kind) || card.kind === 'self' && !!result;
  const correct = result && Array.isArray(result.correctOptionIndexes) ? result.correctOptionIndexes : [], chosen = result && result.feedback && result.feedback.kind === 'choice' ? result.feedback.selectedOptionIndexes : draft.selected;
  d.options.querySelectorAll('.ar-option').forEach((row,index) => { const input = row.querySelector('input'), status = row.querySelector('.ar-option-status'); input.checked = chosen.includes(index); input.dataset.unavailable = String(!!result); row.classList.remove('is-good','is-bad','is-missed'); status.textContent = '';
    if (result) { if (correct.includes(index) && (result.matched === undefined || chosen.includes(index))) { row.classList.add('is-good'); status.textContent = result.matched === undefined ? 'верный' : 'верно'; } else if (result.matched !== undefined && chosen.includes(index) && !correct.includes(index)) { row.classList.add('is-bad'); status.textContent = 'лишнее'; } else if (result.matched !== undefined && correct.includes(index)) { row.classList.add('is-missed'); status.textContent = 'пропущено'; } } });
  d.fields.forEach(input => { input.dataset.unavailable = String(!!result); });
  d.matchPickers.forEach(picker => { picker.trigger.dataset.unavailable = String(!!result); }); d.refreshMatches(); d.renderOrder();
  renderMedia(d.questionMedia,card.questionMedia || []); renderMedia(d.answerMedia,result && result.answerMedia || [],card.questionMedia || []);
  d.source.hidden = !result || !card.source; d.source.replaceChildren(); if (!d.source.hidden) { const source = card.source, places = []; d.source.append(el('summary','','Контекст источника')); if (source.excerpt) d.source.append(el('p','ar-literal',source.excerpt)); if (Number.isSafeInteger(source.page) && source.page >= 0) places.push('Страница ' + source.page); if (Number.isFinite(source.timeSeconds) && source.timeSeconds >= 0) places.push(durationText(source.timeSeconds)); if (places.length) d.source.append(el('p','ar-empty',places.join(' · '))); }
  d.hints.hidden = !card.hints.length; d.hints.replaceChildren(el('h2','','Подсказки · ' + card.hints.length + ' из ' + card.totalHints)); card.hints.forEach(text => d.hints.append(el('p','',text)));
  d.actions.hidden = !!result; d.hint.hidden = card.hints.length >= card.totalHints; d.hint.textContent = card.hints.length ? 'Ещё подсказка' : 'Подсказка'; d.hint.dataset.unavailable = String(card.hints.length >= card.totalHints);
  d.feedback.hidden = !result; d.feedback.replaceChildren();
  if (result) { d.feedback.dataset.tone = result.matched === undefined ? '' : result.matched ? 'good' : 'bad'; d.feedback.append(el('h2','',card.kind === 'self' ? 'Сравните с эталоном' : result.matched === undefined ? 'Ответ для самопроверки' : result.matched ? 'Ответ верный' : 'Есть ошибки'));
    if (card.kind === 'self') { d.feedback.append(recallComparison(result.recalledText === undefined ? draft.text : result.recalledText,result.reference,result.selfCheckCriteria)); if (Array.isArray(result.selfCheckCriteria) && result.selfCheckCriteria.length) { if (card.selectedRating) d.checkedCriteria = (result.checkedCriteria || []).slice(); d.feedback.append(recallCriteria(result.selfCheckCriteria,d.checkedCriteria,card.selectedRating ? null : (index,checked) => { d.checkedCriteria = checked ? Array.from(new Set(d.checkedCriteria.concat(index))).sort((a,b) => a-b) : d.checkedCriteria.filter(value => value !== index); })); } }
    else if (card.kind === 'cloze' && result.feedback && result.feedback.kind === 'cloze' && Array.isArray(result.expectedBlanks)) result.expectedBlanks.forEach((text,index) => { const matched = result.feedback.matchedBlanks[index], line = el('div','ar-blank-result',(matched ? '✓ ' : '× ') + 'Пропуск ' + (index + 1) + ' — ' + text); line.dataset.tone = matched ? 'good' : 'bad'; d.feedback.append(line); });
    else if (card.kind === 'matching') result.correctMatches.forEach((expected,index) => { const submitted = result.feedback && result.feedback.kind === 'matching' ? result.feedback.matches[index] : undefined, matched = submitted === undefined || submitted === expected, line = el('div','ar-blank-result',(submitted === undefined ? '' : matched ? '✓ ' : '× ') + card.matching.left[index] + ' → ' + card.matching.right[expected]); if (submitted !== undefined) line.dataset.tone = matched ? 'good' : 'bad'; if (!matched) line.append(el('p','','Ваш вариант: ' + card.matching.right[submitted])); d.feedback.append(line); });
    else if (card.kind === 'ordering') result.correctOrder.forEach((expected,index) => { const submitted = result.feedback && result.feedback.kind === 'ordering' ? result.feedback.order[index] : undefined, matched = submitted === undefined || submitted === expected, line = el('div','ar-blank-result',(submitted === undefined ? '' : matched ? '✓ ' : '× ') + (index + 1) + '. ' + card.orderItems[expected]); if (submitted !== undefined) line.dataset.tone = matched ? 'good' : 'bad'; if (!matched) line.append(el('p','','Ваш вариант: ' + card.orderItems[submitted])); d.feedback.append(line); });
    else d.feedback.append(el('p','ar-literal',result.reference)); }
  d.grading.hidden = !result || !!card.selectedRating && !editingGrade; d.grading.replaceChildren();
  if (!d.grading.hidden) { d.grading.append(el('p','',editingGrade ? 'Выберите другую оценку' : session && session.mode === 'bank' ? 'Насколько уверенно удалось ответить?' : 'Насколько легко удалось вспомнить?'),gradeButtons(card.allowedRatings, rating => act(editingGrade ? 'change-grade' : 'grade',editingGrade ? {attemptId:card.attemptId,rating} : {rating,advance:true,...answerHistoryFields(card),...(card.kind === 'self' && result.selfCheckCriteria && result.selfCheckCriteria.length ? {checkedCriteria:d.checkedCriteria.slice()} : {})}),true)); if (editingGrade) d.grading.append(button('Оставить прежнюю',() => { editingGrade = false; render(); },'ar-ghost')); }
  d.selectedGrade.hidden = !card.selectedRating || editingGrade; d.selectedGrade.replaceChildren();
  if (card.selectedRating) { const text = el('p','','Оценка: '); text.append(el('strong','',labels[card.selectedRating])); const history = current.history.find(row => row.attemptId === card.attemptId); if (history) text.append(el('span','ar-sync',statuses[history.syncStatus] || 'Статус пока недоступен')); d.selectedGrade.append(text);
    if (card.canChangeGrade) d.selectedGrade.append(button('Изменить оценку',() => { editingGrade = true; render(); },'ar-ghost')); }
  const nextStep = current.nextStep || {kind:'card'}; d.next.textContent = nextStep.kind === 'finished' ? 'Завершить повторение' : nextStep.kind === 'waiting' ? 'К короткому повтору' : nextStep.kind === 'material' ? 'К следующему материалу' + (nextStep.materialTitle ? ' · ' + nextStep.materialTitle : '') : 'Следующая карточка';
  d.next.hidden = !card.selectedRating || editingGrade; updateCheck();
  d.report.replaceChildren(); const report = reportCardView(); d.report.hidden = !report; if (report) d.report.append(report);
  const restored = d.section.querySelector('.ar-draft-recovered'); if (restored) restored.hidden = recoveredDraft !== draft.key || current.status !== 'question';
}
function answerEvidenceComparison(evidence) { const section = el('div','ar-recall-comparison'); for (const [label,text] of [[evidence.answerMatch === true ? 'Ответ верный · эталон' : 'Ваш ответ',evidence.answerMatch === true ? evidence.reference : evidence.answer || 'Текст ответа не записан.'],['Эталон этой попытки',evidence.reference || 'Самопроверка по критериям.']]) { if (evidence.answerMatch === true && label === 'Эталон этой попытки') continue; const column = el('section','ar-recall-column'); column.append(el('h3','',label),el('p','ar-literal',text)); section.append(column); } return section; }
function historyView(lastSession) {
  if (!current.history.length && !lastSession && !(current.answerMistakes || []).length) return null; const details = el('details','ar-history'), summary = el('summary','',lastSession ? 'История последнего занятия' : current.history.length ? 'История · ' + current.history.length : 'История ответов'), list = el('div','ar-history-list'); details.append(summary,list);
  function fill() { list.replaceChildren(); const repeated = (current.answerMistakes || []).filter(row => row.count >= 2); if (repeated.length) { const patterns = el('section','ar-answer-mistakes'); patterns.append(el('h3','','Повторяющиеся ошибки')); repeated.forEach(row => { const item = el('div','ar-answer-mistake'); item.append(el('p','ar-literal',row.question),el('p','ar-literal','«' + row.answer + '» — повторений: ' + row.count)); patterns.append(item); }); list.append(patterns); } if (lastSession && current.session) list.append(el('p','ar-empty','Пройдено карточек: ' + current.session.completed + ' из ' + current.session.total + '. Ответов: ' + current.session.answers + '.')); current.history.slice(-historySize).reverse().forEach(row => { const item = el('article','ar-history-item'), footer = el('div','ar-history-footer'), text = el('div','',labels[row.rating]); text.append(el('span','ar-sync',statuses[row.syncStatus] || 'Статус пока недоступен')); item.append(el('p','',row.question)); footer.append(text);
    if (row.answerEvidence) { const recall = el('details','ar-recall-history'); recall.append(el('summary','',row.answerEvidence.answerMatch === false ? 'Ошибка и эталон' : row.answerEvidence.kind !== 'self' && row.answerEvidence.answerMatch === null ? 'Ответ без автоматической проверки' : 'Сохранённый ответ'),answerEvidenceComparison(row.answerEvidence)); if (row.answerEvidence.criteria && row.answerEvidence.criteria.length) recall.append(recallCriteria(row.answerEvidence.criteria,row.answerEvidence.checkedCriteria || [],null)); item.append(recall); }
    else if (row.recall) { const recall = el('details','ar-recall-history'); recall.append(el('summary','','Ответ и эталон'),recallComparison(row.recall.answer,row.recall.reference,row.recall.criteria)); if (row.recall.criteria && row.recall.criteria.length) recall.append(recallCriteria(row.recall.criteria,row.recall.checkedCriteria || [],null)); item.append(recall); }
    if (row.canChangeGrade && Array.isArray(row.allowedRatings) && row.allowedRatings.length) footer.append(button('Изменить',() => { const existing = item.querySelector('.ar-grades'); if (existing) existing.remove(); else item.append(gradeButtons(row.allowedRatings,rating => act('change-grade',{attemptId:row.attemptId,rating}))); },'ar-ghost')); item.append(footer); list.append(item); });
    if (historySize < current.history.length) list.append(button('Показать ещё',() => { historySize += 20; fill(); },'ar-ghost')); updateDisabled(); }
  details.addEventListener('toggle',() => { if (details.open && !list.childNodes.length) fill(); }); return details;
}
function landing(title, text) { const section = el('section','ar-landing'); section.append(el('h1','',title)); if (text) section.append(el('p','',text)); return section; }
function cardCountLabel(count) { const last = count % 10, lastTwo = count % 100; return count + ' ' + (last === 1 && lastTwo !== 11 ? 'карточка' : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'карточки' : 'карточек'); }
function materialCountLabel(count) { const last = count % 10, lastTwo = count % 100; return count + ' ' + (last === 1 && lastTwo !== 11 ? 'материал' : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'материала' : 'материалов'); }
function durationText(seconds) { const value = Math.max(0,Math.floor(seconds)); return Math.floor(value / 60) + ':' + String(value % 60).padStart(2,'0'); }
function summaryView() { const value = current.summary; if (!value || current.status !== 'finished') return null; const section = el('section','ar-summary'), stats = el('dl','ar-summary-stats'); section.append(el('h2','','Итоги занятия')); const add = (label,text) => { const row = el('div'); row.append(el('dt','',label),el('dd','',String(text))); stats.append(row); }; add('Время',durationText(value.elapsedSeconds)); add('Карточки',value.completed + ' из ' + value.total); add('Ответы',value.answers); add('Пропущено',value.skipped); if (value.unavailable) add('Стали недоступны',value.unavailable); section.append(stats);
  const reason = value.reason === 'inactive' ? 'Занятие завершено после 30 минут без учебных действий. Сохранённые оценки остались в истории.' : value.reason === 'expired' ? 'Занятие завершено: учебные данные изменились или устарели. Выберите материалы заново; если их нет — синхронизируйте Telegram в Obsidian.' : value.reason === 'time-limit' ? 'Время занятия истекло. Сохранённые ответы остались в истории.' : value.reason === 'manual' ? 'Занятие завершено вручную.' : ''; if (reason) section.append(el('p','ar-empty ar-session-end',reason));
  if (value.grades) section.append(el('p','ar-empty','Ваши оценки: ещё раз — ' + value.grades.again + ', трудно — ' + value.grades.hard + ', хорошо — ' + value.grades.good + ', легко — ' + value.grades.easy + '.'));
  if (value.correctness) section.append(el('p','ar-empty','Проверка ответов: верно — ' + value.correctness.correct + ', с ошибками — ' + value.correctness.incorrect + ', без автоматической проверки — ' + value.correctness.unchecked + '.'));
  if (current.session && modeOf(current.session) === 'bank' && current.weakRetry) { const retry = button('Практиковать трудные вопросы · ' + current.weakRetry.cardCount,() => { const fields = startFields('bank'); if (!fields || !current.weakRetry.available) return; planChoosing = false; planContinued = false; picker = false; studyMode = 'bank'; act('start',Object.assign({retryWeak:true,mode:'bank',shuffle:shuffleCards},fields)); },'ar-ghost'); retry.dataset.unavailable = String(!current.weakRetry.available || !startFields('bank')); section.append(retry); }
  return section;
}
const planCommandLabels = {pending:'Ожидает подключения Obsidian',applied:'Подтверждено Obsidian',conflict:'Задача изменилась. Обновите план и проверьте её.',missing:'Задача больше недоступна.',revoked:'Доступ к задаче отключён.',expired:'Срок действия изменения истёк. Обновите план.'};
function calendarStateText(value) { const labels = {waiting:'Google Calendar: ожидает обновления',synced:'Google Calendar: обновлён',disabled:'Google Calendar: синхронизация отключена','not-routed':'Задача не отправляется в Google Calendar',error:'Google Calendar: обновление не завершено',conflict:'Google Calendar: обнаружены встречные изменения'}; if (!value || !Object.prototype.hasOwnProperty.call(labels,value.state)) return ''; let text = labels[value.state]; if (Number.isSafeInteger(value.checkedAt)) { try { text += ' · проверено ' + new Intl.DateTimeFormat('ru-RU',{...(week || today ? {timeZone:(week || today).timeZone} : {}),day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(value.checkedAt); } catch (_) {} } return text; }
function planCommandFor(id) { return (Array.isArray(current.planCommands) ? current.planCommands : []).filter(row => row.entryId === id).sort((a,b) => b.requestedAt-a.requestedAt)[0]; }
function validPlanAction(value) { return value && typeof value.revision === 'string' && /^[a-f0-9]{64}$/.test(value.revision) && typeof value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.date) && typeof value.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.time) && typeof value.canMoveDate === 'boolean' && (value.durationMinutes === undefined || Number.isSafeInteger(value.durationMinutes) && value.durationMinutes >= 1 && value.durationMinutes <= 1440); }
function planActionPanel(row, expired, afterLesson) {
  const section = el('div','ar-stack'), actions = el('div','ar-plan-actions'), command = planCommandFor(row.id), waiting = command && command.status === 'pending';
  if (command) { const line = el('p','ar-plan-command',planCommandLabels[command.status] || 'Статус изменения пока недоступен'); line.dataset.status = command.status; line.setAttribute('role','status'); section.append(line); }
  const calendar = command ? command.status === 'applied' ? command.calendar : null : row.calendar, calendarText = calendarStateText(calendar);
  if (calendarText) { const line = el('p','ar-plan-command',calendarText); line.dataset.status = calendar.state === 'error' || calendar.state === 'conflict' ? 'conflict' : calendar.state; line.setAttribute('role','status'); section.append(line); }
  if (current.planActions !== true || !validPlanAction(row.action)) return section.childElementCount ? section : null;
  const toggle = button(row.completed ? 'Вернуть в работу' : afterLesson ? 'Отметить задачу выполненной' : 'Выполнено',() => act('plan-action',{id:row.id,revision:row.action.revision,action:row.completed ? 'reopen' : 'complete'}),afterLesson && !row.completed ? 'ar-primary' : 'ar-ghost');
  const move = button('Перенести занятие',() => { const value = planEdits.get(row.id); if (value) value.open = !value.open; else planEdits.set(row.id,{revision:row.action.revision,date:row.action.date,time:row.action.time,duration:String(row.action.durationMinutes || 30),open:true}); render(); },'ar-ghost');
  [toggle,move].forEach(control => { control.dataset.unavailable = String(!!expired || !!waiting); actions.append(control); }); section.append(actions);
  const edit = planEdits.get(row.id); if (!edit || !edit.open) return section;
  const form = el('form','ar-plan-edit'), fields = el('div','ar-plan-edit-fields'), status = el('p','ar-empty'), footer = el('div','ar-plan-actions'); status.setAttribute('role','status');
  const date = el('input'), time = el('input'), duration = el('input'); date.type = 'date'; date.value = edit.date; date.dataset.unavailable = String(!row.action.canMoveDate); time.type = 'time'; time.value = edit.time; duration.type = 'text'; duration.inputMode = 'numeric'; duration.maxLength = 4; duration.value = edit.duration;
  [['Дата',date],['Время',time],['Длительность · мин',duration]].forEach(([text,input]) => { const label = el('label','ar-field'); label.append(el('span','',text),input); fields.append(label); });
  const save = button('Сохранить перенос',() => {},'ar-primary'); save.type = 'submit'; const cancel = button('Отмена',() => { planEdits.delete(row.id); render(); },'ar-ghost'); footer.append(save,cancel);
  const validate = () => { const validDate = /^\d{4}-\d{2}-\d{2}$/.test(edit.date) && Number.isFinite(Date.parse(edit.date + 'T00:00:00Z')) && new Date(edit.date + 'T00:00:00Z').toISOString().slice(0,10) === edit.date, validTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(edit.time), minutes = Number(edit.duration), validDuration = /^\d+$/.test(edit.duration) && Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 1440, changed = edit.revision !== row.action.revision; status.textContent = changed ? 'Задача изменилась. Проверьте новые данные перед переносом.' : !validDate || !validTime || !validDuration ? 'Укажите дату, время и длительность от 1 до 1440 минут.' : ''; status.hidden = !status.textContent; date.setAttribute('aria-invalid',String(!validDate)); time.setAttribute('aria-invalid',String(!validTime)); duration.setAttribute('aria-invalid',String(!validDuration)); save.dataset.unavailable = String(!!expired || !!waiting || changed || !validDate || !validTime || !validDuration); updateDisabled(); };
  [[date,'date'],[time,'time'],[duration,'duration']].forEach(([input,key]) => input.addEventListener('input',() => { edit[key] = input.value; validate(); }));
  form.addEventListener('submit',event => { event.preventDefault(); validate(); if (!save.disabled) act('plan-action',{id:row.id,revision:row.action.revision,action:'reschedule',date:edit.date,time:edit.time,durationMinutes:Number(edit.duration)}); });
  if (edit.revision !== row.action.revision) footer.append(button('Загрузить актуальное время',() => { planEdits.set(row.id,{revision:row.action.revision,date:row.action.date,time:row.action.time,duration:String(row.action.durationMinutes || 30),open:true}); render(); },'ar-ghost'));
  form.append(fields,status,footer); section.append(form); validate(); return section;
}
function canRepeatStudyTarget(target) { return validStudyTarget(target) && ['active','transition'].includes(target.status) && target.available > 0 && serverTime() < target.expiresAt; }
function studyTargetView() {
  const target = current.studyTarget; if (!target) return null;
  const stale = target.status === 'stale' || serverTime() >= target.expiresAt;
  const status = stale ? 'stale' : target.status, captions = {active:'Подготовка активна',transition:'Возвращаемся к обычным повторениям',completed:'Подготовка завершена',disabled:'Подготовка выключена',stale:'Нужна синхронизация'};
  const details = el('details','ar-study-target'), summary = el('summary'), copy = el('span','ar-study-target-copy'), body = el('div','ar-study-target-body');
  details.open = studyTargetExpanded; details.dataset.studyTargetStatus = status; details.dataset.studyTargetId = target.id;
  const date = new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',day:'numeric',month:'long',year:'numeric'}).format(Date.parse(target.targetDate + 'T12:00:00Z'));
  const formatTime = at => new Intl.DateTimeFormat('ru-RU',{timeZone:target.timeZone,day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(at);
  copy.append(el('strong','','Подготовка к дате'),el('span','ar-study-target-date',date));
  summary.append(copy,el('span','ar-study-target-status',captions[status]));
  body.append(el('p','ar-study-target-count','К повторению сейчас: ' + cardCountLabel(stale ? 0 : target.available) + '. Всего для подготовки: ' + target.total + '.'));
  if (target.nextDueAt !== undefined && !stale) body.append(el('p','ar-empty','Следующее повторение: ' + formatTime(target.nextDueAt)));
  let description = status === 'stale' ? 'Учебная копия устарела. Откройте Obsidian и синхронизируйте выбранные материалы.'
    : status === 'disabled' ? 'Режим выключен в Obsidian. Обычные повторения доступны в разделе «Занятие».'
    : status === 'completed' ? 'Обычные повторения продолжаются в разделе «Занятие».'
    : target.total === 0 ? 'В Telegram нет карточек выбранной подготовки. Проверьте выбор материалов и синхронизацию в Obsidian.'
    : target.available === 0 ? 'Сейчас повторять нечего.' : '';
  if (description) body.append(el('p','ar-empty',description));
  body.append(el('p','ar-study-target-sync','Синхронизация копии с Obsidian: ' + formatTime(target.syncedAt)));
  const repeat = button('Повторить подготовку',() => {
    if (!details.isConnected || busy || locked || pending || current.studyTarget !== target) return;
    if (!canRepeatStudyTarget(target)) { announce('Обновите данные подготовки перед запуском.'); void loadToday(); return; }
    void openPlan(target.id,true);
  },'ar-primary ar-study-target-repeat');
  repeat.dataset.unavailable = String(!canRepeatStudyTarget(target)); body.append(repeat);
  details.addEventListener('toggle',() => { if (details.isConnected) studyTargetExpanded = details.open; });
  details.append(summary,body); return details;
}
function todayView() {
  const data = planRange === 'week' && week ? week : today, section = landing(planRange === 'week' && week ? 'Ближайшие 7 дней' : 'Сегодня',data ? 'Учебный план · ' + data.timeZone : current.studyTarget ? 'Подготовка и учебные задачи' : 'Учебный план не передан или устарел.');
  const target = studyTargetView(); if (target) section.append(target);
  if (week) { const range = el('nav','ar-views'); range.setAttribute('aria-label','Период учебного плана'); [['today','Сегодня'],['week','7 дней']].forEach(([value,label]) => { const control = button(label,() => { planRange = value; render(); }); control.setAttribute('aria-pressed',String(planRange === value)); range.append(control); }); section.append(range); }
  if (!data) { section.append(el('p','ar-empty',target ? 'Занятия с указанным временем пока не переданы. Их передачу можно включить в Obsidian: «Интеграции → Telegram».' : 'В Obsidian откройте «Интеграции → Telegram», включите «Напоминать в Telegram по учебному плану» и нажмите «Синхронизировать сейчас».'),button('Обновить план',() => loadToday(),'ar-ghost')); return section; }
  const expired = Date.now() >= data.expiresAt; if (expired) section.append(el('p','ar-empty','Данные плана устарели. Обновите список.')); if (!data.rows.length) section.append(el('p','ar-empty',planRange === 'week' ? 'В переданной копии нет ближайших занятий с указанным временем.' : 'На сегодня нет переданных занятий с указанным временем.'));
  const list = el('div','ar-today-list'); let previousDay = ''; data.rows.forEach(row => { const item = el('article','ar-today-item'); let time, day; try { time = new Intl.DateTimeFormat('ru-RU',{timeZone:data.timeZone,hour:'2-digit',minute:'2-digit'}).format(row.startAt); day = new Intl.DateTimeFormat('ru-RU',{timeZone:data.timeZone,weekday:'long',day:'numeric',month:'long'}).format(row.startAt); } catch (_) { time = new Date(row.startAt).toISOString().slice(11,16) + ' UTC'; day = new Date(row.startAt).toISOString().slice(0,10) + ' UTC'; }
    if (planRange === 'week' && day !== previousDay) { const heading = el('h2','',day); heading.className = 'ar-plan-day'; list.append(heading); previousDay = day; }
    const state = row.completed ? 'Выполнено' : row.skipped ? 'Пропущено' : row.available ? 'Доступно' : 'Сейчас недоступно', open = button('Открыть занятие',() => openPlan(row.id),'ar-ghost'); open.dataset.unavailable = String(expired || !row.available);
    item.append(el('p','ar-today-time',time + ' · ' + state),el('h2','',row.title),open); const controls = planActionPanel(row,expired,false); if (controls) item.append(controls); list.append(item);
  }); section.append(list); try { section.append(el('p','ar-empty','Копия плана действует до ' + new Intl.DateTimeFormat('ru-RU',{timeZone:data.timeZone,day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(data.expiresAt) + '.')); } catch (_) {} section.append(button('Обновить план',() => loadToday(),'ar-ghost')); return section;
}
function navigationView() { const section = el('div','ar-navigation'), nav = el('nav','ar-views'); if (vaults.length > 1) { const entries = vaults.map(row => ({value:row.id,label:row.name})), picker = choicePicker('ar-vault','Хранилище',entries,vaultId,id => { picker.update(entries,vaultId); void switchVault(id); }); picker.field.classList.add('ar-vault-picker'); picker.trigger.querySelector('.ar-filter-value').id = 'ar-vault-value'; picker.trigger.setAttribute('aria-describedby','ar-vault-value'); section.append(picker.field); } nav.setAttribute('aria-label','Разделы мини-приложения'); [['study','Занятие'],['today','Сегодня']].forEach(([view,label]) => { const control = button(label,() => { if (view === 'today') loadToday(); else { sectionView = 'study'; render(); } }); control.setAttribute('aria-pressed',String(sectionView === view)); nav.append(control); }); section.append(nav); return section; }
function syncStatusView() {
  const sync = current.sync; if (!sync || !Number.isSafeInteger(sync.generatedAt) || !Number.isSafeInteger(sync.pendingAnswers) || sync.pendingAnswers < 0) return null;
  const commands = Array.isArray(current.planCommands) ? current.planCommands : [], reports = Array.isArray(current.cardReports) ? current.cardReports.filter(row => row.status === 'pending').length : 0, waiting = sync.pendingAnswers + reports + commands.filter(row => row.status === 'pending').length, details = el('details','ar-sync-state');
  let updated; try { updated = new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(sync.generatedAt); } catch (_) { updated = new Date(sync.generatedAt).toISOString(); }
  details.append(el('summary','',waiting ? 'Ожидают Obsidian · ' + waiting : 'Состояние синхронизации'),el('p','ar-empty','Учебная копия обновлена: ' + updated));
  if (waiting) details.append(el('p','ar-empty','Telegram: результаты и изменения сохранены. Ожидают подтверждения Obsidian: ' + waiting + '.'));
  const calendar = new Map(); (week || today || {rows:[]}).rows.forEach(row => { if (row.calendar) calendar.set(row.id,row.calendar); }); commands.slice().sort((a,b) => a.requestedAt-b.requestedAt).forEach(row => { if (row.status === 'applied' && row.calendar) calendar.set(row.entryId,row.calendar); else if (row.status === 'pending') calendar.delete(row.entryId); });
  const delayed = Array.from(calendar.values()).filter(value => value.state === 'waiting').length, failed = Array.from(calendar.values()).filter(value => value.state === 'error' || value.state === 'conflict').length;
  if (delayed) details.append(el('p','ar-empty','Google Calendar: ожидают обновления ' + delayed + ' занятий.'));
  if (failed) details.append(el('p','ar-empty','Google Calendar: требуется проверка ' + failed + ' занятий. Подробности — в учебном плане.'));
  details.append(button('Обновить экран',() => sectionView === 'today' ? loadToday() : loadView(),'ar-ghost')); return details;
}
function closeFilterPicker(restoreFocus) { if (filterPopupClose) filterPopupClose(!!restoreFocus); }
function filterPicker(key, label, values, display) {
  const selected = studyFilters[studyMode][key], available = new Set(values), entries = [{value:'',label:'Все'}];
  if (selected && !available.has(selected)) values = values.concat(selected);
  values.forEach(value => entries.push({value,label:display(value) + (!available.has(value) ? ' · недоступно' : '')}));
  const picker = choicePicker('ar-filter-' + studyMode + '-' + key,label,entries,selected,value => { studyFilters[studyMode][key] = value; render(); const next = root.querySelector('button[name="' + key + '"]'); if (next) next.focus({preventScroll:true}); });
  picker.trigger.name = key; return picker.field;
}
function choicePicker(id, label, entries, selected, onChange) {
  const field = el('div','ar-field ar-filter-field');
  const trigger = button('',() => { if (filterPopupClose && trigger.getAttribute('aria-expanded') === 'true') closeFilterPicker(true); else open(); },'ar-filter-trigger');
  trigger.id = id; trigger.setAttribute('role','combobox'); trigger.setAttribute('aria-labelledby',id + '-label'); trigger.setAttribute('aria-haspopup','listbox'); trigger.setAttribute('aria-expanded','false'); trigger.setAttribute('aria-controls',id + '-list');
  const caption = el('span','',label), copy = el('span','ar-filter-value'), arrow = el('span','ar-filter-chevron'); caption.id = id + '-label'; arrow.setAttribute('aria-hidden','true'); trigger.append(copy,arrow); field.append(caption,trigger); caption.addEventListener('click',() => { if (!trigger.disabled) trigger.click(); });
  const update = (values,value) => { entries = values; selected = value; const chosen = entries.find(entry => entry.value === selected) || entries[0]; copy.textContent = chosen.label; trigger.title = chosen.label; trigger.dataset.placeholder = String(!selected); };
  update(entries,selected);
  function open(index, focusSearch) {
    if (busy || locked || pending || trigger.disabled || !trigger.isConnected) return;
    closeFilterPicker(); const popup = el('div','ar-filter-popup'), list = el('div','ar-filter-options'), search = entries.length > 8 ? el('input','ar-filter-search') : null;
    list.id = id + '-list'; list.setAttribute('role','listbox'); list.setAttribute('aria-label',label);
    if (search) { search.type = 'search'; search.placeholder = 'Найти'; search.setAttribute('aria-label','Найти: ' + label); search.autocomplete = 'off'; popup.append(search); }
    popup.append(list); document.body.append(popup); trigger.setAttribute('aria-expanded','true'); let buttons = [], prefix = '', prefixAt = 0;
    const finish = restore => { if (filterPopupClose !== finish) return; filterPopupClose = null; trigger.setAttribute('aria-expanded','false'); popup.remove(); document.removeEventListener('pointerdown',outside,true); document.removeEventListener('focusin',outside,true); document.removeEventListener('scroll',scrolled,true); window.removeEventListener('resize',resized); if (window.visualViewport) { visualViewport.removeEventListener('resize',resized); visualViewport.removeEventListener('scroll',resized); } if (restore && trigger.isConnected && !trigger.disabled) trigger.focus({preventScroll:true}); };
    const outside = event => { if (!popup.contains(event.target) && !trigger.contains(event.target)) finish(false); };
    const scrolled = event => { if (!popup.contains(event.target)) finish(false); }, resized = () => { if (search && document.activeElement === search) position(); else finish(false); };
    const position = () => { const viewport = window.visualViewport, left = viewport ? viewport.offsetLeft : 0, top = viewport ? viewport.offsetTop : 0, width = viewport ? viewport.width : innerWidth, height = viewport ? viewport.height : innerHeight, rect = trigger.getBoundingClientRect(); const below = Math.max(0,top + height - rect.bottom - 14), above = Math.max(0,rect.top - top - 14), up = above > below; popup.style.width = Math.min(Math.max(rect.width,260),width - 16) + 'px'; popup.style.left = Math.max(left + 8,Math.min(rect.left,left + width - popup.getBoundingClientRect().width - 8)) + 'px'; popup.style.maxHeight = Math.max(0,Math.min(336,height - 16,Math.max(below,above))) + 'px'; popup.style.top = (up ? Math.max(top + 8,rect.top - popup.getBoundingClientRect().height - 6) : rect.bottom + 6) + 'px'; };
    const focus = at => { if (!buttons.length) return; const option = buttons[(at + buttons.length) % buttons.length]; option.focus({preventScroll:true}); const item = option.getBoundingClientRect(), frame = list.getBoundingClientRect(); if (item.top < frame.top) list.scrollTop -= frame.top - item.top; else if (item.bottom > frame.bottom) list.scrollTop += item.bottom - frame.bottom; };
    const fill = () => { list.replaceChildren(); buttons = []; const query = search ? search.value.trim().toLocaleLowerCase() : ''; entries.filter(entry => !query || entry.label.toLocaleLowerCase().includes(query)).forEach(entry => { const option = button('',() => { if (option.disabled || busy || locked || pending || !trigger.isConnected) return; finish(false); update(entries,entry.value); onChange(entry.value); if (trigger.isConnected && !trigger.disabled) trigger.focus({preventScroll:true}); },'ar-filter-option'); option.setAttribute('role','option'); option.setAttribute('aria-selected',String(entry.value === selected)); option.setAttribute('aria-disabled',String(!!entry.disabled)); option.disabled = !!entry.disabled; option.dataset.value = entry.value; option.tabIndex = -1; const check = el('span','ar-filter-check',entry.value === selected ? '✓' : ''); check.setAttribute('aria-hidden','true'); option.append(el('span','ar-filter-option-label',entry.label),check); list.append(option); if (!entry.disabled) buttons.push(option); }); if (!list.childElementCount) list.append(el('p','ar-filter-empty','Ничего не найдено')); position(); };
    const keys = event => { if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return; if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(true); return; } if (event.key === 'Tab') { finish(true); return; } const at = buttons.indexOf(document.activeElement), typing = search && event.target === search; let next; if (event.key === 'ArrowDown') next = at < 0 ? 0 : at + 1; else if (event.key === 'ArrowUp') next = at < 0 ? buttons.length - 1 : at - 1; else if (event.key === 'Home' && !typing) next = 0; else if (event.key === 'End' && !typing) next = buttons.length - 1; else if (!typing && event.key.length === 1 && event.key !== ' ') { const now = Date.now(); prefix = now - prefixAt < 700 ? prefix + event.key.toLocaleLowerCase() : event.key.toLocaleLowerCase(); prefixAt = now; next = buttons.findIndex(option => option.textContent.toLocaleLowerCase().startsWith(prefix)); if (next < 0) return; } else return; event.preventDefault(); event.stopPropagation(); focus(next); };
    filterPopupClose = finish; fill(); popup.addEventListener('keydown',keys); if (search) search.addEventListener('input',fill); document.addEventListener('pointerdown',outside,true); document.addEventListener('focusin',outside,true); document.addEventListener('scroll',scrolled,true); window.addEventListener('resize',resized); if (window.visualViewport) { visualViewport.addEventListener('resize',resized); visualViewport.addEventListener('scroll',resized); }
    const selectedIndex = buttons.findIndex(option => option.dataset.value === selected); if (search && focusSearch !== false && index === undefined) search.focus({preventScroll:true}); else focus(index === undefined ? Math.max(0,selectedIndex) : index);
  }
  trigger.addEventListener('keydown',event => { if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing || !['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); open(event.key === 'Home' ? 0 : event.key === 'End' ? -1 : undefined,false); });
  return {field,trigger,update};
}
function applyPreset(value) {
  studyMode = value.mode; selectedPreset = value.id; presetName = value.name; presetsOpen = true;
  const rows = targetMaterials(), selected = selectedMaterials(), available = new Set(rows.filter(row => row.count > 0).map(row => row.id)); selected.clear(); value.materials.filter(id => available.has(id)).forEach(id => selected.add(id));
  const cards = catalogCards(), allowed = {learningGroup:cards.map(card => card.group),questionKind:cards.map(card => card.kind),section:cards.flatMap(card => card.sections || []),topic:cards.flatMap(card => card.topics || []),tag:cards.flatMap(card => card.tags || []),knowledgeState:cards.map(card => card.knowledgeState)};
  let removed = selected.size !== value.materials.length; Object.keys(studyFilters[studyMode]).forEach(key => { const wanted = value.filters[key], found = allowed[key].find(item => typeof item === 'string' && (key === 'tag' ? item.toLocaleLowerCase() === wanted.toLocaleLowerCase() : item === wanted)); studyFilters[studyMode][key] = wanted && found || ''; if (wanted && !found) removed = true; });
  startSettings[studyMode].cardLimit = value.cardLimit; startSettings[studyMode].timeLimitMinutes = value.timeLimitMinutes ? String(Math.min(90,Number(value.timeLimitMinutes))) : ''; shuffleCards = value.shuffle;
  presetFeedback = removed ? 'Сценарий применён. Недоступные материалы и фильтры исключены; проверьте выбор.' : 'Сценарий применён. Можно начать занятие.'; render(); const name = $('ar-preset-name'); if (name) name.focus({preventScroll:true}); announce(presetFeedback);
}
function presetView() {
  if (!localState.available() || planChoosing) return null;
  const presets = localState.presets(), panel = el('details','ar-start-settings ar-presets'), body = el('div','ar-stack'), nameLabel = el('label','ar-field'), name = el('input'), status = el('p','ar-empty',presetFeedback), actions = el('div','ar-secondary');
  panel.append(el('summary','','Сценарии занятий')); panel.open = presetsOpen; panel.addEventListener('toggle',() => { if (panel.isConnected) presetsOpen = panel.open; }); status.setAttribute('role','status'); status.hidden = !presetFeedback;
  const entries = [{value:'',label:'Новый сценарий'},...presets.map(value => ({value:value.id,label:value.name + ' · ' + modeLabel(value.mode)}))];
  const picker = choicePicker('ar-preset-choice','Сохранённый сценарий',entries,selectedPreset,id => { const value = presets.find(value => value.id === id); if (value) applyPreset(value); else { selectedPreset = ''; presetName = ''; presetFeedback = ''; presetsOpen = true; render(); const input = $('ar-preset-name'); if (input) input.focus({preventScroll:true}); } }); body.append(picker.field);
  name.id = 'ar-preset-name'; name.type = 'text'; name.maxLength = 60; name.autocomplete = 'off'; name.value = presetName; name.placeholder = 'Например, английский на 10 минут'; nameLabel.append(el('span','','Название сценария'),name); body.append(nameLabel);
  async function work(remove) {
    if (busy || locked || pending) return; const fields = startFields(), chosen = targetMaterials().filter(row => selectedMaterials().has(row.id) && row.count > 0).map(row => row.id), title = presetName.trim();
    if (!remove && (!fields || !chosen.length || !title || title.length > 60 || presets.some(value => value.id !== selectedPreset && value.name.toLocaleLowerCase() === title.toLocaleLowerCase()))) return;
    setBusy(true,remove ? 'Удаляем сценарий…' : 'Сохраняем сценарий…');
    const id = selectedPreset || crypto.randomUUID(); let saved = false;
    try { saved = remove ? await localState.deletePreset(id) : await localState.savePreset({id,name:title,mode:studyMode,materials:chosen,filters:Object.assign({},studyFilters[studyMode]),cardLimit:startSettings[studyMode].cardLimit.trim(),timeLimitMinutes:startSettings[studyMode].timeLimitMinutes.trim(),shuffle:shuffleCards});
      if (saved) { selectedPreset = remove ? '' : id; presetName = remove ? '' : title; presetFeedback = remove ? 'Сценарий удалён.' : 'Сценарий сохранён на этом устройстве.'; } else presetFeedback = 'Не удалось сохранить изменение сценария. Проверьте доступ к хранилищу и повторите попытку.';
      presetsOpen = true; render();
    } finally { setBusy(false); const input = $('ar-preset-name'); if (input) input.focus({preventScroll:true}); announce(presetFeedback); }
  }
  const save = button(selectedPreset ? 'Обновить сценарий' : 'Сохранить сценарий',() => { void work(false); },'ar-ghost'), remove = button('Удалить сценарий',() => { void work(true); },'ar-ghost');
  const validate = () => { presetName = name.value; const duplicate = presets.some(value => value.id !== selectedPreset && value.name.toLocaleLowerCase() === presetName.trim().toLocaleLowerCase()), chosen = targetMaterials().some(row => row.count > 0 && selectedMaterials().has(row.id)); save.dataset.unavailable = String(!presetName.trim() || duplicate || !chosen || !startFields()); remove.dataset.unavailable = String(!selectedPreset); name.setAttribute('aria-invalid',String(duplicate)); status.textContent = duplicate ? 'Сценарий с таким названием уже есть.' : presetFeedback; status.hidden = !status.textContent; updateDisabled(); };
  name.addEventListener('input',validate); name.addEventListener('keydown',event => { if (event.key === 'Enter' && !event.isComposing && !event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); validate(); if (save.dataset.unavailable !== 'true') void work(false); } }); actions.append(save,remove); body.append(actions,status); panel.append(body); presetRefresh = validate; validate(); return panel;
}
function topicRecallPicker(materials) {
  const section = el('section','ar-stack ar-topic-recall'), toggle = button('Вспомнить тему',() => { topicRecallExpanded = !topicRecallExpanded; show(); },'ar-ghost'), body = el('div','ar-stack');
  let allowed = [], selected = '';
  const options = choicePicker('ar-topic-recall-card','Карточка с планом темы',[{value:'',label:'Выберите план темы'}],topicRecallSelected,value => { topicRecallSelected = value; selected = value; updateStart(); });
  const start = button('Начать вспоминание темы',() => { const card = allowed.find(row => row.id === selected), fields = startFields('bank'); if (!card || !fields || unfinished()) return; act('start',Object.assign({},fields,{materialIds:[card.materialId],mode:'bank',cardLimit:1,shuffle:false,topicRecallCardId:card.id})); },'ar-primary');
  const note = el('p','ar-empty'); note.setAttribute('role','status');
  body.id = 'ar-topic-recall-body'; toggle.setAttribute('aria-controls',body.id); body.append(options.field,note,start); section.append(toggle,body);
  function show() { body.hidden = !topicRecallExpanded; toggle.setAttribute('aria-expanded',String(topicRecallExpanded)); }
  function updateStart() { start.dataset.unavailable = String(!allowed.some(row => row.id === selected) || !startFields('bank') || !!unfinished()); updateDisabled(); }
  function update(ids) {
    allowed = catalogCards('bank').filter(row => ids.includes(row.materialId) && typeof row.recallPrompt === 'string' && matchesStudyFilter(row,studyFilters.bank));
    if (!allowed.some(row => row.id === topicRecallSelected)) topicRecallSelected = '';
    selected = topicRecallSelected;
    options.update([{value:'',label:'Выберите план темы'},...allowed.map(row => ({value:row.id,label:(materials.find(material => material.id === row.materialId)?.title || 'Материал') + ' · ' + row.recallPrompt}))],selected);
    note.textContent = unfinished() ? 'Завершите или продолжите текущее занятие, прежде чем начинать новое.' : !ids.length ? 'Сначала выберите материал.' : !allowed.length ? 'Подготовьте в Obsidian карточку с планом темы: свободный ответ, самопроверка, Банк. Затем синхронизируйте материал.' : 'Выберите подготовленную автором карточку с планом. Откроется только она; остальные вопросы материала в этот подход не входят.';
    options.trigger.dataset.unavailable = String(!allowed.length || !!unfinished()); updateStart();
  }
  show(); return {section,update};
}
function renderMaterials() { presetRefresh = null; const section = landing('Занятие',startConflict ? 'Занятие «' + startConflict + '» не запущено. Выберите материалы ещё раз.' : studyMode === 'bank' ? 'Выберите материалы для практики.' : 'Выберите материалы для повторения.'), modes = el('div','ar-study-modes'), list = el('fieldset','ar-options ar-material-list'), search = el('input'), materials = pickerMaterials(), selected = selectedMaterials(); search.type = 'search'; search.placeholder = 'Найти материал'; search.setAttribute('aria-label','Найти материал');
  modes.setAttribute('role','tablist'); modes.setAttribute('aria-label','Режим занятия'); list.id = 'study-materials'; list.setAttribute('role','tabpanel'); list.setAttribute('aria-labelledby','study-mode-' + studyMode);
  const changeMode = mode => { if (busy || locked || pending || mode === studyMode) return; studyMode = mode; clearError(); render(); const control = root.querySelector('[data-study-mode="' + mode + '"]'); if (control) control.focus({preventScroll:true}); };
  ['core','bank'].forEach(mode => { const count = pickerMaterials(mode).reduce((total,row) => total + row.count,0), tab = button('',() => changeMode(mode)); tab.id = 'study-mode-' + mode; tab.dataset.studyMode = mode; tab.setAttribute('role','tab'); tab.setAttribute('aria-selected',String(mode === studyMode)); tab.setAttribute('aria-controls','study-materials'); tab.tabIndex = mode === studyMode ? 0 : -1; tab.append(el('span','',modeLabel(mode)),el('span','ar-mode-count',String(count))); tab.addEventListener('keydown',event => { if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key) || event.ctrlKey || event.altKey || event.metaKey) return; event.preventDefault(); changeMode(event.key === 'Home' ? 'core' : event.key === 'End' ? 'bank' : mode === 'core' ? 'bank' : 'core'); }); modes.append(tab); }); section.append(modes);
  const start = button(studyMode === 'bank' ? 'Начать практику' : 'Начать повторение',() => { const fields = startFields(); if (fields) { const ids = materials.filter(row => selected.has(row.id) && row.count > 0).map(row => row.id), available = modeMaterials().filter(row => row.count > 0), scope = !planChoosing && ids.length === available.length && available.every(row => selected.has(row.id)) ? {allMaterials:true} : {materialIds:ids}; act('start',Object.assign({mode:studyMode,shuffle:shuffleCards},scope,fields)); } },'ar-primary'), selection = el('div','ar-secondary');
  if (Array.isArray(current.catalog)) { const filters = el('div','ar-study-filters ar-material-filters'), cards = catalogCards(), groups = Array.from(new Set(cards.map(card => card.group).filter(Boolean))).sort(), questionKinds = Array.from(new Set(cards.map(card => card.kind))), sections = Array.from(new Set(cards.flatMap(card => card.sections || []))).sort(), topics = Array.from(new Set(cards.flatMap(card => card.topics || []))).sort(), tags = tagFilterLabels(cards), states = Object.keys(knowledgeStateLabels).filter(state => cards.some(card => card.knowledgeState === state)); const selectedTag = tags.find(tag => tag.toLocaleLowerCase() === studyFilters[studyMode].tag.toLocaleLowerCase()); if (selectedTag) studyFilters[studyMode].tag = selectedTag; const addFilter = (key,label,values,display) => { if (values.length || studyFilters[studyMode][key]) filters.append(filterPicker(key,label,values,display)); }; addFilter('learningGroup','Учебная группа',groups,value => value); addFilter('questionKind','Тип вопроса',questionKinds,value => value === 'free' ? 'Свободный ответ' : kinds[value] || value); addFilter('section','Раздел',sections,value => value); addFilter('topic','Тема',topics,value => value); addFilter('tag','Тег',tags,value => value); addFilter('knowledgeState','Состояние знаний',states,value => knowledgeStateLabels[value] || value); if (filters.childElementCount) section.append(filters); if (states.length || studyFilters[studyMode].knowledgeState) section.append(el('p','ar-empty','Состояние знаний — по последней синхронизации с Obsidian.')); }
  const shuffle = el('label','ar-shuffle'), shuffleInput = el('input'); shuffleInput.type = 'checkbox'; shuffleInput.checked = shuffleCards; shuffle.append(shuffleInput,el('span','','Перемешать карточки')); shuffleInput.addEventListener('change',() => { shuffleCards = shuffleInput.checked; });
  const settings = el('details','ar-start-settings'), limits = el('div','ar-study-filters'), settingsError = el('p','ar-empty','Укажите от 1 до 1000 карточек и от 1 до 90 минут или оставьте поле пустым.'); settings.append(el('summary','','Настройки занятия'),limits,settingsError); settingsError.setAttribute('role','status'); [['cardLimit','Карточек',1000],['timeLimitMinutes','Минут',90]].forEach(([key,label,max]) => { const field = el('label','ar-field'), input = el('input'); input.type = 'text'; input.inputMode = 'numeric'; input.autocomplete = 'off'; input.maxLength = 4; input.placeholder = key === 'timeLimitMinutes' ? 'До 90 минут' : 'Без лимита'; input.value = startSettings[studyMode][key]; input.setAttribute('aria-label',label); input.addEventListener('input',() => { startSettings[studyMode][key] = input.value; const raw = input.value.trim(), value = Number(raw); input.setAttribute('aria-invalid',String(!!raw && (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max))); updateSelection(); }); field.append(el('span','',label),input); limits.append(field); });
  const settingsMode = studyMode; settings.open = settingsOpen[settingsMode]; settings.addEventListener('toggle',() => { if (settings.isConnected) settingsOpen[settingsMode] = settings.open; });
  const topicRecall = studyMode === 'bank' && current.topicRecallSupported === true ? topicRecallPicker(materials) : null;
  const visible = () => materials.filter(row => row.title.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
  const all = button('Выбрать все материалы',() => { visible().filter(row => row.count > 0).forEach(row => selected.add(row.id)); fill(); },'ar-ghost'), none = button('Снять весь выбор',() => { selected.clear(); fill(); },'ar-ghost'); selection.append(all,none); if (Object.values(studyFilters[studyMode]).some(Boolean)) selection.append(button('Сбросить фильтры',() => { Object.keys(studyFilters[studyMode]).forEach(key => { studyFilters[studyMode][key] = ''; }); render(); const next = root.querySelector('[role="combobox"]') || root; next.focus({preventScroll:true}); },'ar-ghost'));
  function updateSelection() { const chosen = materials.filter(row => selected.has(row.id) && row.count > 0), fields = startFields(), count = Math.min(chosen.reduce((total,row) => total + row.count,0),fields && fields.cardLimit || Infinity); start.textContent = chosen.length ? 'Начать · ' + materialCountLabel(chosen.length) + ' · ' + cardCountLabel(count) : studyMode === 'bank' ? 'Начать практику' : 'Начать повторение'; const validSettings = !!fields; start.dataset.unavailable = String(!chosen.length || !validSettings || !!unfinished()); settingsError.hidden = validSettings; none.dataset.unavailable = String(!chosen.length); if (topicRecall) topicRecall.update(chosen.map(row => row.id)); if (presetRefresh) presetRefresh(); updateDisabled(); }
  let materialPage = 0; const materialPageSize = 100, pager = el('div','ar-secondary'), pageStatus = el('span','ar-count'); pager.setAttribute('aria-label','Страницы материалов'); pageStatus.setAttribute('aria-live','polite');
  const previousPage = button('Предыдущие материалы',() => { materialPage--; fill(); (previousPage.disabled ? nextPage : previousPage).focus({preventScroll:true}); },'ar-ghost'), nextPage = button('Следующие материалы',() => { materialPage++; fill(); (nextPage.disabled ? previousPage : nextPage).focus({preventScroll:true}); },'ar-ghost'); pager.append(previousPage,pageStatus,nextPage);
  function fill() { const query = search.value.trim(), found = visible(), pages = Math.ceil(found.length / materialPageSize); materialPage = Math.max(0,Math.min(materialPage,pages - 1)); all.textContent = query ? 'Выбрать найденные' : 'Выбрать все материалы'; all.dataset.unavailable = String(!found.some(row => row.count > 0 && !selected.has(row.id))); list.replaceChildren(el('legend','ar-sr',studyMode === 'bank' ? 'Материалы для практики' : 'Материалы для повторения')); found.slice(materialPage * materialPageSize,(materialPage + 1) * materialPageSize).forEach(row => { const node = el('label','ar-option ar-material-choice'), input = el('input'); input.type = 'checkbox'; input.checked = selected.has(row.id); input.dataset.unavailable = String(row.count <= 0); node.append(input,el('span','ar-option-text',row.title),el('span','ar-count',String(row.count))); input.addEventListener('change',() => { if (input.checked) selected.add(row.id); else selected.delete(row.id); all.dataset.unavailable = String(!found.some(item => item.count > 0 && !selected.has(item.id))); updateSelection(); }); list.append(node); }); if (!found.length) list.append(el('p','ar-empty',materials.length ? 'Материалы не найдены.' : planChoosing && planId ? 'Для этого занятия в выбранном режиме сейчас нет карточек.' : studyMode === 'bank' ? 'В выбранных материалах нет доступных вопросов Банка.' : 'В выбранных материалах сейчас нет карточек Core к повторению.')); pager.hidden = pages <= 1; previousPage.dataset.unavailable = String(materialPage === 0); nextPage.dataset.unavailable = String(materialPage + 1 >= pages); pageStatus.textContent = found.length ? String(materialPage * materialPageSize + 1) + '–' + Math.min(found.length,(materialPage + 1) * materialPageSize) + ' из ' + found.length : ''; updateSelection(); }
  search.addEventListener('input',() => { materialPage = 0; fill(); }); if (materials.length > 6) section.append(search); section.append(selection,list,pager,settings,shuffle,start); if (topicRecall) section.append(topicRecall.section); fill(); const savedScenarios = presetView(); if (savedScenarios) section.append(savedScenarios);
  const shortcut = el('div','ar-stack'), shortcutNotice = el('p','ar-empty'); shortcutNotice.setAttribute('role','status'); shortcut.append(button('Добавить ярлык',() => { homeScreenMessage = ''; updateHomeScreenAction(); try { tg.addToHomeScreen(); } catch (_) { homeScreenMessage = 'Не удалось добавить ярлык. Можно продолжить занятие.'; updateHomeScreenAction(); } },'ar-ghost'),shortcutNotice); homeScreenDom = {section:shortcut,notice:shortcutNotice}; updateHomeScreenAction(); section.append(shortcut);
  if (unfinished()) { const previous = el('div','ar-stack'); previous.append(el('p','ar-empty','Есть прежнее незавершённое занятие: пройдено ' + current.session.completed + ' из ' + current.session.total + '.'),button('Продолжить прежнее занятие',() => { startConflict = ''; picker = false; planChoosing = false; planContinued = !!planId; studyMode = modeOf(current.session); clearError(); render(); },'ar-ghost'),button('Завершить прежнее занятие',() => act('finish'),'ar-ghost')); section.append(previous); }
  return section;
}
function render(collapseHistory) {
  cancelOrderInteraction(); closeFilterPicker();
  clearTimeout(waitingTimer); clearTimeout(lessonTimer); waitingDom = null; sessionTimerDom = null; if (!current) return; if (current.status === 'paused') suspendMedia(); const focused = root.contains(document.activeElement) ? document.activeElement : null, oldHistory = root.querySelector('.ar-history'); if (oldHistory) historyOpen = oldHistory.open; const wasOpen = historyOpen;
  if (sectionView === 'today') { mediaNodes.forEach(node => node.pause()); root.replaceChildren(navigationView(),todayView()); const sync = syncStatusView(); if (sync) root.append(sync); updateDisabled(); return; }
  if ((current.status === 'question' || current.status === 'result') && current.card && !picker) { if (!cardDom) createCard(); root.replaceChildren(cardDom.section); updateCard(); }
  else { let section; if (current.status === 'materials' || picker) section = renderMaterials();
    else if (current.status === 'paused') { section = landing('Занятие на паузе','Учебное время заморожено. Автоматические запросы остановлены.'); section.classList.add('ar-paused'); if (connectionExpiresAt) section.append(el('p','ar-empty','Подключение доступно до '+new Date(connectionExpiresAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})+'. После этого откройте занятие заново.')); section.append(button('Продолжить занятие',() => act('resume'),'ar-primary'),button('Завершить занятие',() => act('finish'),'ar-ghost')); }
    else if (current.status === 'waiting') { section = landing('Короткая пауза'); const description = el('p'), timer = el('div','ar-waiting-countdown'), proceed = button('Продолжить',() => act('next',waitingRemaining() > 0 && current.session && current.session.canContinueEarly ? {early:true} : {}),'ar-primary'), compatibility = el('p','ar-empty','Для досрочного продолжения обновите плагин и синхронизируйте Telegram.'); timer.setAttribute('role','timer'); timer.setAttribute('aria-live','off'); timer.setAttribute('aria-label','До следующего повтора'); section.append(description,timer,proceed,compatibility); waitingDom = {description,timer,continue:proceed,compatibility}; }
    else if (current.status === 'finished') { const session = current.session; section = landing(session && session.mode === 'bank' ? 'Практика завершена' : 'Занятие завершено',session ? 'Пройдено карточек: ' + session.completed + ' из ' + session.total + '. Ответов: ' + session.answers + '.' : 'Все ответы сохранены в истории.'); section.append(button('Выбрать материалы',() => { picker = true; render(); },'ar-primary')); }
    else if (current.status === 'chat-active') { section = landing('Прежнее занятие в чате',current.chatSessionId ? 'Завершите его, чтобы выбрать материалы в приложении. Выставленные оценки сохранятся.' : 'Откройте приложение заново кнопкой бота.'); if (current.chatSessionId) section.append(button('Завершить и выбрать материалы',() => act('finish-chat',{chatSessionId:current.chatSessionId}),'ar-primary')); section.append(button('Проверить снова',() => loadView(),'ar-ghost')); }
    else { section = landing('Материалы недоступны','Откройте Obsidian и проверьте подключение Telegram и выбранные материалы, затем синхронизируйте их.'); section.append(button('Обновить экран',() => loadView(),'ar-primary')); if (current.materials.some(row => row.count > 0)) section.append(button('Выбрать доступный материал',() => { picker = true; render(); },'ar-ghost')); }
    root.replaceChildren(section); }
  if (launch) { const context = el('aside','ar-plan-context'); context.append(el('p','','По учебному плану: ' + launch.title)); if (!launch.available) context.append(el('p','ar-empty','Занятие по этому напоминанию сейчас недоступно. Обновите экран или проверьте план в Obsidian.'),button('Обновить экран',() => loadView(),'ar-ghost')); else if (planContinued && unfinished()) context.append(button('Выбрать занятие по плану',() => { planChoosing = true; picker = true; studyMode = launch.mode || (pickerMaterials('core').some(row => row.count > 0) ? 'core' : 'bank'); render(); },'ar-ghost')); root.prepend(context); }
  const summary = summaryView(); if (summary) { if (launch && current.status === 'finished') { const controls = planActionPanel(launch,false,true); if (controls) summary.append(controls); } root.prepend(summary); } const timer = sessionTimerView(); if (timer) root.prepend(timer); root.prepend(navigationView());
  const history = picker && current.status !== 'finished' && !planId ? null : historyView(picker && current.status === 'finished'); if (history) { history.open = !collapseHistory && !!wasOpen; root.append(history); }
  if (current.session && ['question','result','waiting'].includes(current.status) && !picker && !(current.card && current.card.selectedRating && current.nextStep && current.nextStep.kind === 'finished')) { const bottom = el('div','ar-bottom'); bottom.append(button('Пропустить сейчас',() => act('skip'),'ar-ghost'),button('Пауза',() => act('pause'),'ar-ghost'),button('Завершить занятие',() => act('finish'),'ar-ghost')); if (!current.card || current.card.selectedRating) bottom.firstChild.hidden = true; root.append(bottom); }
  const sync = syncStatusView(); if (sync) root.append(sync);
  if (current.status !== 'paused') resumeMedia(); updateWaitingCountdown(); updateSessionTimer(); updateDisabled(); if (focused && focused.isConnected && !focused.disabled && !focused.closest('[hidden]')) focused.focus({preventScroll:true});
}
function releaseMedia(keepCached) { mediaEpoch++; mediaQueue.splice(0); mediaDeferred.clear(); mediaSuspended = false; mediaControllers.forEach(controller => controller.abort()); mediaControllers.clear(); mediaNodes.forEach(node => { node.pause(); node.removeAttribute('src'); node.load(); }); mediaNodes.clear(); objectUrls.forEach(url => URL.revokeObjectURL(url)); objectUrls.clear(); mediaEntries.clear(); if (!keepCached) mediaCache.clear(); }
function suspendMedia() { mediaSuspended = true; mediaNodes.forEach(node => node.pause()); mediaControllers.forEach(controller => controller.abort('pause')); }
function resumeMedia() { if (!mediaSuspended) return; mediaSuspended = false; const deferred = [...mediaDeferred]; mediaDeferred.clear(); deferred.forEach(load => load()); pumpMedia(); }
function pumpMedia() { while (!mediaSuspended && mediaActive < 2 && mediaQueue.length) { const work = mediaQueue.shift(); mediaActive++; work().finally(() => { mediaActive--; pumpMedia(); }); } }
function renderMedia(container, assets, shown) { const keys = JSON.stringify([assets,shown || []]); if (container.dataset.assets === keys) return; container.dataset.assets = keys; container.replaceChildren();
  assets.forEach(asset => {
    const shared = (shown || []).find(previous => previous.id === asset.id);
    if (shared) {
      // A content hash identifies the same file; keep its question player and answer-only text.
      if (asset.caption && asset.caption !== shared.caption) container.append(el('p','ar-empty ar-literal',asset.caption));
      if (asset.alt && asset.alt !== shared.alt && asset.alt !== asset.caption) container.append(el('p','ar-sr',asset.alt));
      return;
    }
    const figure = el('figure','ar-attachment'), status = el('div','ar-media-status'), label = asset.kind === 'image' ? 'Изображение' : asset.kind === 'audio' ? 'Аудио' : 'Видео'; status.append(el('span','',label)); figure.append(status); if (asset.caption) figure.append(el('figcaption','',asset.caption)); container.append(figure);
    let running = false; const epoch = mediaEpoch;
    const load = () => { if (epoch !== mediaEpoch) return; if (mediaSuspended) { mediaDeferred.add(load); return; } if (running) return; running = true; status.replaceChildren(el('span','','Загружаем ' + label.toLocaleLowerCase() + '…'));
      mediaQueue.push(async () => { if (epoch !== mediaEpoch) return; const controller = new AbortController(); mediaControllers.add(controller); const timer = setTimeout(() => controller.abort(),60000);
        try { let url = mediaEntries.get(asset.id); if (!url) { const blob = await mediaCache.load(asset,bearer,controller.signal); if (epoch !== mediaEpoch) return; url = URL.createObjectURL(blob); objectUrls.add(url); mediaEntries.set(asset.id,url); }
          if (epoch !== mediaEpoch) return; if (mediaSuspended) { running = false; mediaDeferred.add(load); return; } const node = el(asset.kind === 'image' ? 'img' : asset.kind); if (asset.kind === 'image') node.alt = asset.alt || asset.caption || 'Вложение карточки'; else { node.controls = true; node.preload = 'metadata'; mediaNodes.add(node); }
          node.addEventListener('error',() => { if (epoch !== mediaEpoch || node.parentNode !== figure) return; running = false; status.replaceChildren(el('span','','Не удалось открыть вложение.'),button('Повторить',load,'ar-ghost')); figure.replaceChild(status,node); if (asset.kind !== 'image') { node.pause(); node.removeAttribute('src'); node.load(); mediaNodes.delete(node); } if (mediaEntries.get(asset.id) === url) mediaEntries.delete(asset.id); mediaCache.forget(asset.id); objectUrls.delete(url); URL.revokeObjectURL(url); updateDisabled(); },{once:true});
          node.src = url; figure.replaceChild(node,status);
        } catch (problem) { if (epoch !== mediaEpoch) return; running = false; if (controller.signal.aborted && controller.signal.reason === 'pause') { status.replaceChildren(el('span','','Загрузка на паузе.')); mediaDeferred.add(load); if (!mediaSuspended) { mediaDeferred.delete(load); load(); } return; } status.replaceChildren(el('span','','Не удалось загрузить вложение.'),button('Повторить',load,'ar-ghost')); if (problem.status === 401 || problem.status === 403) { locked = true; handleFailure(problem); updateDisabled(); } }
        finally { clearTimeout(timer); mediaControllers.delete(controller); }
      }); pumpMedia(); };
    if (asset.kind !== 'image' && asset.bytes > 5000000) status.append(button('Загрузить',load,'ar-ghost')); else load();
  });
}
$('close').addEventListener('click',close); $('error-close').addEventListener('click',close); $('retry').addEventListener('click',() => { if (retryWork && !busy) retryWork(); });
document.addEventListener('keydown',gradeOnNumber);
document.addEventListener('visibilitychange',() => { if (document.visibilityState === 'hidden') markSuspended(); else scheduleResume(); });
window.addEventListener('blur',markSuspended);
window.addEventListener('focus',() => scheduleResume());
window.addEventListener('online',() => { if (pending && pending.kind === 'resume' && !busy && !locked) void sendPending(); });
window.addEventListener('pagehide',event => { clearTimeout(resumeTimer); clearTimeout(lifetimeTimer); clearTimeout(lessonTimer); cancelOrderInteraction(); persistDraft(); closeFilterPicker(); releaseMedia(); cardDom = null; if (!event.persisted) bearer = ''; clearTimeout(waitingTimer); });
window.addEventListener('pageshow',event => { if (event.persisted) { if (bearer && current && !locked) scheduleResume(true); else { bearer = ''; locked = false; authenticate(); } } });
theme(); if (tg) { try { tg.ready(); tg.expand(); tg.onEvent('themeChanged',theme); if (typeof tg.isVersionAtLeast === 'function' && tg.isVersionAtLeast('8.0')) { tg.onEvent('deactivated',markSuspended); tg.onEvent('activated',() => scheduleResume(true)); } } catch (_) {} }
setupFullscreen();
setupHomeScreen();
authenticate();
})();`;
