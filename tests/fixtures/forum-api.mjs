import {createHash} from 'node:crypto';
export const urls=['https://api.example.test/v1','https://cdn.example.test/v1'];
export const keys=[1,2,3].map(index=>'sk-'+createHash('sha256').update('public OCR fixture '+index).digest('hex'));
export const models=[['gpt-5.6-fixture','gpt-6-fixture'],['ds-4.1-fixture','ds-4.1-fixture-1017'],['glm-5.3-fixture']];
