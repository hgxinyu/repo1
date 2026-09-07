import {api} from './guide-client.js';
import {publishedWeeklyGuides, weeklyEdition} from './weekly-guides.mjs';
let latest;
function showLatest(){
 const target=document.getElementById('cardWeeklySub');
 if(target&&latest)target.textContent=weeklyEdition(latest,localStorage.getItem('flipgame_lang')).title;
}
api('',{signal:AbortSignal.timeout(5000)}).then(result=>{latest=publishedWeeklyGuides(result.guides)[0];showLatest();}).catch(()=>{});
document.getElementById('langToggle')?.addEventListener('click',()=>queueMicrotask(showLatest));
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
