(() => {
    const parseIntParam = (value) => {
        if (value === null || value === undefined || value === '') return null;
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : null;
    };

    const parseFloatParam = (value) => {
        if (value === null || value === undefined || value === '') return null;
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
    };

    const parseBooleanValue = (value, fallback) => {
        if (value === null || value === undefined || value === '') return fallback;
        if (typeof value === 'boolean') return value;
        const normalized = String(value).toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
        if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
        return fallback;
    };

    const configBase = window.__donorTopConfig || {};
    const queryParams = new URLSearchParams(window.location.search);
    const limitCandidate = parseIntParam(queryParams.get('count')) ?? parseIntParam(queryParams.get('limit')) ?? parseIntParam(configBase.limit);
    const limit = Math.min(Math.max(limitCandidate ?? 5, 1), 20);
    const intervalCandidate = parseIntParam(queryParams.get('interval')) ?? parseIntParam(configBase.interval);
    const intervalSeconds = Math.min(Math.max(intervalCandidate ?? 5, 1), 60);
    const intervalMs = intervalSeconds * 1000;
    const isDaily = queryParams.has('daily') ? true : !!configBase.daily;
    const startParam = queryParams.get('startDate') || configBase.startDate || '';
    const endParam = queryParams.get('endDate') || configBase.endDate || '';
    const frameEnabled = parseBooleanValue(queryParams.get('frame'), parseBooleanValue(configBase.frame, true));
    const opacityCandidate = parseFloatParam(queryParams.get('opacity')) ?? parseFloatParam(configBase.opacity);
    const opacityValue = Math.min(Math.max(opacityCandidate ?? 0.95, 0.05), 1);
    const BASE_NAME_SIZE = 1.2;
    const MIN_NAME_SIZE = 0.7;
    let donors = [];
    let currentIndex = 0;
    let rotationTimer = null;
    let wsConnection = null;

    const buildUrl = () => {
        const params = new URLSearchParams();
        params.set('limit', limit);
        if (isDaily) {
            params.set('daily', '1');
        } else {
            if (startParam) params.set('startDate', startParam);
            if (endParam) params.set('endDate', endParam);
        }
        return `/api/top-donors?${params.toString()}`;
    };

    const formatDuration = (value) => {
        const seconds = Math.max(0, Math.floor(value || 0));
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        const parts = [];
        if (d) parts.push(`${d}д`);
        if (h) parts.push(`${h}ч`);
        if (m) parts.push(`${m}м`);
        if (s) parts.push(`${s}с`);
        if (!parts.length) {
            return '+0с';
        }
        return `+${parts.join(' ')}`;
    };

    const adjustNameSize = () => {
        const container = document.getElementById('donorName');
        const nameEl = document.getElementById('donorNameInner');
        if (!container || !nameEl) return;
        requestAnimationFrame(() => {
            let fontSize = BASE_NAME_SIZE;
            nameEl.style.fontSize = `${fontSize}rem`;
            const maxWidth = container.clientWidth;
            while (fontSize > MIN_NAME_SIZE && nameEl.scrollWidth > maxWidth) {
                fontSize = Math.max(MIN_NAME_SIZE, fontSize - 0.05);
                nameEl.style.fontSize = `${fontSize}rem`;
            }
        });
    };

    const renderDonor = (index) => {
        const containerName = document.getElementById('donorNameInner');
        const amountEl = document.getElementById('donorAmount');
        const timeEl = document.getElementById('donorTime');
        if (!donors.length || !containerName || !amountEl || !timeEl) return;
        const donor = donors[index % donors.length];
        containerName.textContent = donor.username || '—';
        amountEl.textContent = `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(donor.total_amount || 0)} ₽`;
        timeEl.textContent = formatDuration(donor.total_time_seconds);
        adjustNameSize();
        applyRankGlow((index % donors.length) + 1);
    };

    const applyRankGlow = (rank) => {
        if (!rankGlow) return;
        rankGlow.className = 'rank-glow';
        rankGlow.style.opacity = '';
        if (rank === 1) {
            rankGlow.classList.add('rank-1');
            rankGlow.classList.add('has-top-overlay');
        } else if (rank === 2) {
            rankGlow.classList.add('rank-2');
            rankGlow.classList.add('has-top-overlay');
        } else if (rank === 3) {
            rankGlow.classList.add('rank-3');
            rankGlow.classList.add('has-top-overlay');
        } else if (rank === 4) {
            rankGlow.classList.add('rank-4');
        } else if (rank === 5) {
            rankGlow.classList.add('rank-5');
        } else {
            rankGlow.classList.add('rank-default');
        }
    };

    const startRotation = () => {
        if (rotationTimer) clearInterval(rotationTimer);
        if (donors.length <= 1) return;
        rotationTimer = setInterval(() => {
            currentIndex = (currentIndex + 1) % donors.length;
            renderDonor(currentIndex);
        }, intervalMs);
    };

    const fetchUrl = buildUrl();
    const topEntry = document.getElementById('topEntry');
    const noDonors = document.getElementById('noDonors');
    const widgetEl = document.querySelector('.top-widget');
    const rankGlow = document.getElementById('rankGlow');
    const topTitle = document.getElementById('topTitle');
    
    // Устанавливаем заголовок в зависимости от режима
    if (topTitle) {
        topTitle.textContent = isDaily ? 'ТОП ДНЯ' : 'ОТМЫВАЛЬЩИКИ';
    }
    if (widgetEl) {
        const startColor = `rgba(8, 8, 15, ${opacityValue})`;
        const endColor = `rgba(12, 12, 20, ${opacityValue})`;
        const borderAlpha = 0.15 * opacityValue;
        widgetEl.style.setProperty('--bg-start', startColor);
        widgetEl.style.setProperty('--bg-end', endColor);
        widgetEl.style.setProperty('--border-color', `rgba(255, 255, 255, ${borderAlpha})`);
        if (!frameEnabled) {
            widgetEl.classList.add('no-frame');
        } else {
            widgetEl.classList.remove('no-frame');
        }
    }
    const fetchDonors = async () => {
        if (!topEntry || !noDonors) return;
        try {
            const response = await fetch(fetchUrl, { cache: 'no-store' });
            const data = await response.json();
            const newDonors = Array.isArray(data.donors) ? data.donors : [];
            if (!newDonors.length) {
                topEntry.style.display = 'none';
                noDonors.style.display = 'block';
                if (rotationTimer) clearInterval(rotationTimer);
                if (rankGlow) rankGlow.style.opacity = '0';
                donors = [];
                return;
            }
            
            // Проверяем, изменились ли данные
            const dataChanged = JSON.stringify(donors) !== JSON.stringify(newDonors);
            donors = newDonors;
            
            topEntry.style.display = 'flex';
            noDonors.style.display = 'none';
            
            // Сбрасываем ротацию только если данные действительно изменились
            // или если ротация еще не запущена
            if (dataChanged || !rotationTimer) {
                currentIndex = 0;
                renderDonor(currentIndex);
                startRotation();
            }
            // Если данные не изменились, продолжаем ротацию с текущего индекса
        } catch (error) {
            console.error('Ошибка загрузки топ-доноров:', error);
            topEntry.style.display = 'none';
            noDonors.style.display = 'block';
            if (rankGlow) rankGlow.style.opacity = '0';
        }
    };

    const connectWebSocket = () => {
        if (wsConnection) {
            wsConnection.close();
            wsConnection = null;
        }
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const connectionUrl = `${protocol}//${window.location.host}/ws?type=widget`;
        wsConnection = new WebSocket(connectionUrl);
        wsConnection.addEventListener('message', (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'NEW_DONATION' || data.type === 'STATE_UPDATE' || data.type === 'TOP_DONORS_UPDATE') {
                    fetchDonors();
                }
            } catch (e) {
                console.warn('Top donors WS parse error', e);
            }
        });
        wsConnection.addEventListener('close', () => setTimeout(connectWebSocket, 3000));
    };

    const init = () => {
        fetchDonors();
        setInterval(fetchDonors, 60000);
        connectWebSocket();
        window.addEventListener('resize', adjustNameSize);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

