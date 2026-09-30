const ids = ['paperName','tagline','edition','price','category','headline','dek','article','author','location','caption','accentColor','paperColor','theme','breaking','breakingText'];
const $ = (id) => document.getElementById(id);
const value = (id) => $(id).type === 'checkbox' ? $(id).checked : $(id).value;
const defaults = Object.fromEntries(ids.map(id => [id, value(id)]));
const defaultLogo = 'assets/turtle-media-logo.png';
let logoData = defaultLogo, heroData = '', pages = [], currentPage = 0, zoom = 1, hydrated = false;

function slugify(input) {
  return (input || 'krant').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60) || 'krant';
}
function formatDate() {
  return new Intl.DateTimeFormat('nl-NL',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(new Date()).toUpperCase();
}
function readPage() { return { fields:Object.fromEntries(ids.map(id => [id,value(id)])), logoData, heroData }; }
function blankPage() {
  const page = structuredClone(readPage());
  Object.assign(page.fields, { category:'NIEUWS', headline:'NIEUWE KOP', dek:'Schrijf hier de korte introductie van het verhaal.', article:'Begin hier met het nieuwe artikel.', caption:'' });
  page.heroData = '';
  return page;
}
function writePage(page) {
  for (const id of ids) {
    if (page.fields[id] === undefined) continue;
    if ($(id).type === 'checkbox') $(id).checked = !!page.fields[id]; else $(id).value = page.fields[id];
  }
  logoData = typeof page.logoData === 'string' ? page.logoData : defaultLogo;
  heroData = typeof page.heroData === 'string' ? page.heroData : '';
}
function project() {
  if (pages.length) pages[currentPage] = readPage();
  return { version:2, slug:slugify(value('paperName')), activePage:currentPage, pages:structuredClone(pages) };
}
function saveLocal() { if (hydrated) localStorage.setItem('fivem-krantenstudio-autosave', JSON.stringify(project())); }
function renderTabs() {
  $('pageTabs').replaceChildren(...pages.map((page,index) => {
    const button = document.createElement('button');
    button.className = `page-tab${index === currentPage ? ' active' : ''}`;
    button.dataset.page = index;
    button.innerHTML = `<strong>Pagina ${String(index + 1).padStart(2,'0')}</strong><span></span>`;
    button.querySelector('span').textContent = page.fields.headline || `Pagina ${index + 1}`;
    return button;
  }));
  $('deletePage').disabled = pages.length === 1;
}
function render(save=true) {
  $('vPaperName').textContent=value('paperName')||'NAAM KRANT'; $('vFooterName').textContent=value('paperName')||'NAAM KRANT';
  $('vTagline').textContent=value('tagline'); $('vEdition').textContent=value('edition'); $('vPrice').textContent=value('price');
  $('vDate').textContent=formatDate(); $('vCategory').textContent=value('category'); $('vHeadline').textContent=value('headline')||'JOUW KOP HIER';
  $('vDek').textContent=value('dek'); $('vArticle').textContent=value('article'); $('vAuthor').textContent=value('author'); $('vLocation').textContent=value('location'); $('vCaption').textContent=value('caption');
  $('vPageNumber').textContent=String(currentPage+1).padStart(2,'0');
  $('vBreaking').textContent=value('breakingText'); $('vBreaking').hidden=!value('breaking');
  $('newspaper').style.setProperty('--accent',value('accentColor')); $('newspaper').style.setProperty('--paper',value('paperColor')); $('newspaper').className=`newspaper ${value('theme')}`;
  $('vLogo').src=logoData; $('vLogo').style.display=logoData?'block':'none'; $('vHero').src=heroData; $('vHero').style.display=heroData?'block':'none';
  $('heroFrame').classList.toggle('placeholder',!heroData); $('heroFrame').querySelector('span').hidden=!!heroData;
  if (pages.length) pages[currentPage] = readPage(); renderTabs(); if (save) saveLocal();
}
function applyProject(data) {
  if (!data || ![1,2].includes(data.version)) throw new Error('Ongeldig krantenproject');
  pages = data.version === 1 ? [{fields:data.fields,logoData:data.logoData,heroData:data.heroData}] : data.pages;
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 64 || pages.some(page => !page || !page.fields)) throw new Error('Ongeldige pagina’s');
  currentPage = Math.max(0,Math.min(Number(data.activePage)||0,pages.length-1)); writePage(pages[currentPage]); hydrated=true; render(false); saveLocal(); requestAnimationFrame(fitPage);
}
function switchPage(index) {
  if (index === currentPage || !pages[index]) return;
  pages[currentPage]=readPage(); currentPage=index; writePage(pages[currentPage]); render(); document.querySelector('.editor').scrollTo({top:0,behavior:'smooth'}); requestAnimationFrame(fitPage);
}
function toast(message){ const el=$('toast');el.textContent=message;el.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('show'),2600); }
function readImage(file,done){ if(!file)return; if(file.size>12*1024*1024){toast('Afbeelding is groter dan 12 MB');return;} const reader=new FileReader();reader.onload=()=>done(reader.result);reader.readAsDataURL(file); }
function setZoom(next){ zoom=Math.max(.4,Math.min(1.4,next));$('newspaper').style.zoom=zoom;$('zoomLabel').textContent=`${Math.round(zoom*100)}%`; }
function fitPage(){ const wrap=$('newspaper').parentElement;const horizontal=(wrap.clientWidth-64)/794;const vertical=(wrap.clientHeight-64)/1123;setZoom(Math.min(1,horizontal,vertical));wrap.scrollTo({top:0,left:0}); }
async function capturePage(page,scale) { writePage(page); render(false); setZoom(1); await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); return html2canvas($('newspaper'),{scale,useCORS:true,backgroundColor:value('paperColor')}); }

for(const id of ids) $(id).addEventListener($(id).type==='color'||$(id).tagName==='SELECT'||$(id).type==='checkbox'?'change':'input',()=>render());
$('logoFile').addEventListener('change',e=>readImage(e.target.files[0],v=>{logoData=v;render();})); $('heroFile').addEventListener('change',e=>readImage(e.target.files[0],v=>{heroData=v;render();}));
$('clearLogo').addEventListener('click',()=>{logoData='';$('logoFile').value='';render();});
$('pageTabs').addEventListener('click',event=>{const button=event.target.closest('[data-page]');if(button)switchPage(Number(button.dataset.page));});
$('addPage').addEventListener('click',()=>{pages[currentPage]=readPage();pages.push(blankPage());currentPage=pages.length-1;writePage(pages[currentPage]);render();requestAnimationFrame(fitPage);toast(`Pagina ${pages.length} toegevoegd`);});
$('duplicatePage').addEventListener('click',()=>{pages[currentPage]=readPage();pages.splice(currentPage+1,0,structuredClone(pages[currentPage]));currentPage++;writePage(pages[currentPage]);render();toast('Pagina gedupliceerd');});
$('deletePage').addEventListener('click',()=>{if(pages.length===1)return;pages.splice(currentPage,1);currentPage=Math.min(currentPage,pages.length-1);writePage(pages[currentPage]);render();requestAnimationFrame(fitPage);toast('Pagina verwijderd');});
$('newProject').addEventListener('click',()=>{for(const id of ids){if($(id).type==='checkbox')$(id).checked=defaults[id];else $(id).value=defaults[id];}logoData=defaultLogo;heroData='';pages=[readPage()];currentPage=0;hydrated=true;render();requestAnimationFrame(fitPage);toast('Nieuwe Turtle Media-krant gestart');});
$('saveProject').addEventListener('click',async()=>{const result=await window.desktop.saveProject(project());if(!result.canceled)toast(`${pages.length} pagina’s opgeslagen`);});
$('loadProject').addEventListener('click',async()=>{try{const result=await window.desktop.loadProject();if(!result.canceled){applyProject(result.project);toast(`${pages.length} pagina’s geopend`);}}catch{toast('Dit project kon niet worden geopend');}});
async function exportPng(){
  toast(`Pagina ${currentPage+1} wordt opgebouwd…`);pages[currentPage]=readPage();const original=currentPage,previous=zoom;const canvas=await capturePage(pages[currentPage],3);writePage(pages[original]);render(false);setZoom(previous);
  const result=await window.desktop.savePng({slug:`${slugify(value('paperName'))}-pagina-${String(original+1).padStart(2,'0')}`,dataUrl:canvas.toDataURL('image/png')});if(!result.canceled)toast('Pagina als PNG opgeslagen');
}
async function exportPdf(){
  pages[currentPage]=readPage();const original=currentPage,previous=zoom,images=[];toast(`PDF met ${pages.length} pagina’s wordt opgebouwd…`);
  try { for(let index=0;index<pages.length;index++){currentPage=index;const canvas=await capturePage(pages[index],2);images.push(canvas.toDataURL('image/png'));} }
  finally { currentPage=original;writePage(pages[original]);render(false);setZoom(previous); }
  const result=await window.desktop.savePdf({slug:slugify(value('paperName')),pages:images});if(!result.canceled)toast(`PDF met ${pages.length} pagina’s opgeslagen`);
}
$('exportPng').addEventListener('click',exportPng);$('exportPngBottom').addEventListener('click',exportPng);$('exportPdf').addEventListener('click',exportPdf);$('exportPdfBottom').addEventListener('click',exportPdf);
$('zoomOut').addEventListener('click',()=>setZoom(zoom-.1));$('zoomIn').addEventListener('click',()=>setZoom(zoom+.1));$('zoomFit').addEventListener('click',fitPage);window.addEventListener('resize',()=>{if(zoom<1)fitPage();});
try { const saved=JSON.parse(localStorage.getItem('fivem-krantenstudio-autosave')); if(saved) applyProject(saved); else {pages=[readPage()];hydrated=true;render();} } catch {pages=[readPage()];hydrated=true;render();}
requestAnimationFrame(fitPage);

async function initializePublisherLinks() {
  try {
    const update = await window.desktop.checkUpdates();
    if (update.storeUrl) $('fourthwallButton').hidden = false;
    if (update.available) {
      $('updateButton').hidden = false;
      $('updateButton').textContent = `Update ${update.version} beschikbaar`;
      $('updateButton').dataset.available = 'true';
    }
  } catch {
    // De app blijft volledig bruikbaar wanneer de updatecontrole offline is.
  }
}
$('fourthwallButton').addEventListener('click', async () => {
  try { await window.desktop.openStore(); } catch { toast('Fourthwall kon niet worden geopend'); }
});
$('updateButton').addEventListener('click', async () => {
  if ($('updateButton').dataset.available !== 'true') return;
  $('updateButton').disabled = true;
  $('updateButton').textContent = 'Update downloaden…';
  try { await window.desktop.installUpdate(); }
  catch { $('updateButton').disabled = false; $('updateButton').textContent = 'Update opnieuw proberen'; toast('De update kon niet veilig worden geïnstalleerd'); }
});
initializePublisherLinks();
