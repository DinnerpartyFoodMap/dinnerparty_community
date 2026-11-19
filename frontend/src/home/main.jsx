import React from 'react';
import { createRoot } from 'react-dom/client';
import HomePage from './HomePage.jsx';
import { t } from '../i18n/index.js';
import './home.css';

// /home 下载页的入口（frontend/home/index.html）：海报二维码扫进来先到这里，不加载地图与隐私确认
document.title = t('home:documentTitle');
createRoot(document.getElementById('home-root')).render(<HomePage />);
