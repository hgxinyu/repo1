import test from 'node:test';
import assert from 'node:assert/strict';
import {publishedWeeklyGuides,weeklyEdition} from '../../assets/weekly-guides.mjs';
test('latest weekly issue excludes unpublished and other categories; editing does not change issue order',()=>{
 const old={id:'old',category:'weekly',status:'published',publishedAt:'2026-08-28',updatedAt:'2026-10-01'};
 const latest={id:'new',category:'weekly',status:'published',publishedAt:'2026-09-04',updatedAt:'2026-09-04'};
 assert.deepEqual(publishedWeeklyGuides([old,latest,{...latest,id:'draft',status:'draft'},{...latest,id:'vip',category:'vip'}]).map(g=>g.id),['new','old']);
 assert.deepEqual(publishedWeeklyGuides([old,{...latest,status:'draft'}]).map(g=>g.id),['old']);
 assert.deepEqual(publishedWeeklyGuides([]),[]);
});
test('weekly editions follow language with explicit fallback and retain all pages',()=>{
 const guide={title:'中文',titleEn:'English',pages:['zh1','zh2'],pagesEn:['en1','en2']};
 assert.deepEqual(weeklyEdition(guide,'en'),{title:'English',pages:['en1','en2'],notice:''});
 assert.deepEqual(weeklyEdition({...guide,pagesEn:[]},'en'),{title:'English',pages:['zh1','zh2'],notice:'Chinese edition only'});
 assert.equal(weeklyEdition({...guide,pages:[]},'zh').notice,'仅英文版');
});
