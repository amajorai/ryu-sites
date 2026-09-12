import { defineConfig } from "@playwright/test";
export default defineConfig({testDir:"e2e",timeout:90000,expect:{timeout:15000},use:{headless:true,viewport:{width:1440,height:960}},reporter:"list",outputDir:"/tmp/ryu-sites-playwright-results"});
