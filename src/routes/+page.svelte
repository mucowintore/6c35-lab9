<script>
  import { onMount } from 'svelte';
  import * as d3 from 'd3';
  import mapboxgl from 'mapbox-gl';
  import 'mapbox-gl/dist/mapbox-gl.css';

  const CAMBRIDGE_CENTER = [-71.1034, 42.3656];
  const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
  const BOSTON_BIKE_ROUTES_URL =
    'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson?outSR=%7B%22latestWkid%22%3A3857%2C%22wkid%22%3A102100%7D';
  const CAMBRIDGE_BIKE_ROUTES_URL =
    'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson';
  const STATIONS_URL = 'https://vis-society.github.io/labs/9/data/bluebikes-stations.csv';
  const TRIPS_URL = 'https://vis-society.github.io/labs/9/data/bluebikes-traffic-2024-03.csv';
  const ISO_URL_BASE = 'https://api.mapbox.com/isochrone/v1/mapbox/';
  const ISO_PROFILE = 'cycling';
  const ISO_MINUTES = [5, 10, 15, 20];
  const ISO_CONTOUR_COLORS = ['03045e', '0077b6', '00b4d8', '90e0ef'];

  let mapContainer;
  let map;
  let mapError = '';
  let stations = [];
  let trips = [];
  let arrivals = new Map();
  let departures = new Map();
  let timeFilter = -1;
  let filteredArrivals = new Map();
  let filteredDepartures = new Map();
  let filteredStations = [];
  let projectedStations = [];
  let overlayWidth = 0;
  let overlayHeight = 0;
  let selectedStation = null;
  let isochrone = null;
  let mapViewChanged = 0;

  const lanePaint = {
    'line-color': '#2f9e44',
    'line-width': 3,
    'line-opacity': 0.4
  };
  const stationFlow = d3
    .scaleQuantize()
    .domain([0, 1])
    .range([0, 0.5, 1]);
  $: timeFilterLabel = new Date(0, 0, 0, 0, timeFilter).toLocaleString('en', { timeStyle: 'short' });
  $: filteredTrips =
    timeFilter === -1
      ? trips
      : trips.filter((trip) => {
          const startedMinutes = minutesSinceMidnight(trip.started_at);
          const endedMinutes = minutesSinceMidnight(trip.ended_at);
          return Math.abs(startedMinutes - timeFilter) <= 60 || Math.abs(endedMinutes - timeFilter) <= 60;
        });
  $: filteredDepartures = d3.rollup(
    filteredTrips,
    (v) => v.length,
    (d) => d.start_station_id
  );
  $: filteredArrivals = d3.rollup(
    filteredTrips,
    (v) => v.length,
    (d) => d.end_station_id
  );
  $: filteredStations = stations.map((station) => {
    const id = station.Number;
    const arr = filteredArrivals.get(id) ?? 0;
    const dep = filteredDepartures.get(id) ?? 0;
    return {
      ...station,
      arrivals: arr,
      departures: dep,
      totalTraffic: arr + dep
    };
  });
  $: radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(filteredStations, (d) => d.totalTraffic) || 0])
    .range(timeFilter === -1 ? [0, 25] : [3, 30]);
  $: if (selectedStation) {
    getIso(+selectedStation.Long, +selectedStation.Lat);
  } else {
    isochrone = null;
  }

  async function initMap() {
    if (!MAPBOX_TOKEN) {
      mapError = 'Missing Mapbox token. Set VITE_MAPBOX_TOKEN in your environment.';
      return;
    }

    mapboxgl.accessToken = MAPBOX_TOKEN;
    map = new mapboxgl.Map({
      container: mapContainer,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: CAMBRIDGE_CENTER,
      zoom: 12.2,
      minZoom: 10,
      maxZoom: 18
    });

    await new Promise((resolve) => map.on('load', resolve));

    map.addSource('boston_route', {
      type: 'geojson',
      data: BOSTON_BIKE_ROUTES_URL
    });

    map.addLayer({
      id: 'boston-bike-lanes',
      type: 'line',
      source: 'boston_route',
      paint: lanePaint
    });

    map.addSource('cambridge_route', {
      type: 'geojson',
      data: CAMBRIDGE_BIKE_ROUTES_URL
    });

    map.addLayer({
      id: 'cambridge-bike-lanes',
      type: 'line',
      source: 'cambridge_route',
      paint: lanePaint
    });

    stations = await d3.csv(STATIONS_URL, (d) => ({
      ...d,
      Lat: Number(d.Lat),
      Long: Number(d.Long)
    }));
    trips = await d3.csv(TRIPS_URL).then((rows) => {
      for (const trip of rows) {
        trip.started_at = new Date(trip.started_at);
        trip.ended_at = new Date(trip.ended_at);
      }
      return rows;
    });

    departures = d3.rollup(
      trips,
      (v) => v.length,
      (d) => d.start_station_id
    );
    arrivals = d3.rollup(
      trips,
      (v) => v.length,
      (d) => d.end_station_id
    );
    stations = stations.map((station) => {
      const id = station.Number;
      const stationArrivals = arrivals.get(id) ?? 0;
      const stationDepartures = departures.get(id) ?? 0;
      return {
        ...station,
        arrivals: stationArrivals,
        departures: stationDepartures,
        totalTraffic: stationArrivals + stationDepartures
      };
    });

    projectStations();
    map.on('move', projectStations);
    map.on('zoom', projectStations);
    map.on('resize', projectStations);
  }

  function minutesSinceMidnight(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  function projectStations() {
    if (!map || filteredStations.length === 0) {
      projectedStations = [];
      return;
    }

    overlayWidth = mapContainer.clientWidth;
    overlayHeight = mapContainer.clientHeight;
    projectedStations = filteredStations.map((station) => {
      const point = map.project(new mapboxgl.LngLat(station.Long, station.Lat));
      return {
        ...station,
        x: point.x,
        y: point.y
      };
    });
    mapViewChanged += 1;
  }

  $: if (map && filteredStations.length > 0) {
    projectStations();
  }

  async function getIso(lon, lat) {
    if (!mapboxgl.accessToken) return;
    const base = `${ISO_URL_BASE}${ISO_PROFILE}/${lon},${lat}`;
    const params = new URLSearchParams({
      contours_minutes: ISO_MINUTES.join(','),
      contours_colors: ISO_CONTOUR_COLORS.join(','),
      polygons: 'true',
      access_token: mapboxgl.accessToken
    });
    const url = `${base}?${params.toString()}`;
    const query = await fetch(url, { method: 'GET' });
    isochrone = await query.json();
  }

  function geoJSONPolygonToPath(feature) {
    if (!map || !feature?.geometry) return '';

    const path = d3.path();
    const { type, coordinates } = feature.geometry;
    const polygons = type === 'Polygon' ? [coordinates] : coordinates;

    for (const polygon of polygons) {
      for (const ring of polygon) {
        for (let i = 0; i < ring.length; i += 1) {
          const [lng, lat] = ring[i];
          const { x, y } = map.project([lng, lat]);
          if (i === 0) path.moveTo(x, y);
          else path.lineTo(x, y);
        }
        path.closePath();
      }
    }

    return path.toString();
  }

  function toggleSelectedStation(station) {
    selectedStation = selectedStation?.Number !== station?.Number ? station : null;
  }

  onMount(() => {
    initMap();

    return () => {
      map?.off('move', projectStations);
      map?.off('zoom', projectStations);
      map?.off('resize', projectStations);
      map?.remove();
    };
  });
</script>

<svelte:head>
  <title>BlueBikes Traffic Map</title>
</svelte:head>

<main>
  <header class="page-header">
    <h1>BlueBikes Traffic Map</h1>
    <label class="time-filter">
      Filter by time:
      <input type="range" min="-1" max="1440" bind:value={timeFilter} />
      {#if timeFilter !== -1}
        <time>{timeFilterLabel}</time>
      {:else}
        <em>(any time)</em>
      {/if}
    </label>
  </header>
  <p class="lede">
    This interactive map visualizes bike lanes, station demand, and traffic flow in Cambridge and Boston.
  </p>

  <section class="map-wrapper" aria-label="Map region">
    <div id="map" bind:this={mapContainer} role="img" aria-label="Map loading area"></div>
    {#if map && projectedStations.length > 0}
      <svg class="station-overlay" viewBox={`0 0 ${overlayWidth} ${overlayHeight}`}>
        {#key mapViewChanged}
          {#if isochrone?.features}
            {#each isochrone.features as feature}
              <path
                d={geoJSONPolygonToPath(feature)}
                fill={feature.properties.fillColor
                  ? (feature.properties.fillColor.startsWith('#')
                    ? feature.properties.fillColor
                    : `#${feature.properties.fillColor}`)
                  : '#0077b6'}
                fill-opacity="0.2"
                stroke="#000000"
                stroke-opacity="0.5"
                stroke-width="1"
              >
                <title>{feature.properties.contour} minutes of biking</title>
              </path>
            {/each}
          {/if}

          {#each projectedStations as station}
            <circle
              cx={station.x}
              cy={station.y}
              r={radiusScale(station.totalTraffic)}
              class:selected={station?.Number === selectedStation?.Number}
              role="button"
              tabindex="0"
              aria-label={`Station ${station.NAME}`}
              aria-pressed={station?.Number === selectedStation?.Number}
              style={`--departure-ratio: ${
                stationFlow(station.totalTraffic > 0 ? station.departures / station.totalTraffic : 0.5)
              }`}
              on:click={() => toggleSelectedStation(station)}
              on:keydown={(evt) => {
                if (evt.key === 'Enter' || evt.key === ' ') {
                  evt.preventDefault();
                  toggleSelectedStation(station);
                }
              }}
            >
              <title>{station.totalTraffic} trips ({station.departures} departures, {station.arrivals} arrivals)</title>
            </circle>
          {/each}
        {/key}
      </svg>
    {/if}
  </section>

  <div class="legend" aria-label="Traffic flow legend">
    <div style="--departure-ratio: 1">More departures</div>
    <div style="--departure-ratio: 0.5">Balanced</div>
    <div style="--departure-ratio: 0">More arrivals</div>
  </div>

  {#if mapError}
    <p class="warning">{mapError}</p>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    font: 100%/1.5 system-ui;
  }

  main {
    max-width: 72rem;
    margin: 0 auto;
    padding: 1rem;
  }

  .page-header {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    flex-wrap: wrap;
  }

  h1 {
    margin: 0;
    line-height: 1.1;
  }

  .time-filter {
    margin-left: auto;
    display: inline-flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.95rem;
  }

  .time-filter input {
    width: min(20rem, 80vw);
  }

  .time-filter time,
  .time-filter em {
    display: block;
    min-height: 1.2rem;
    line-height: 1.2;
  }

  .time-filter em {
    color: #6b7280;
    font-style: italic;
  }

  .lede {
    margin: 0.6rem 0 1rem;
    color: #4b5563;
  }

  .map-wrapper {
    position: relative;
    border: 1px solid #d1d5db;
    border-radius: 0.5rem;
    overflow: hidden;
    background: #f3f4f6;
  }

  #map {
    width: 100%;
    min-height: 32rem;
  }

  .station-overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .station-overlay circle,
  .legend > div {
    --color-departures: steelblue;
    --color-arrivals: darkorange;
    --color: color-mix(
      in oklch,
      var(--color-departures) calc(100% * var(--departure-ratio)),
      var(--color-arrivals)
    );
  }

  .station-overlay circle {
    fill: var(--color);
    fill-opacity: 0.6;
    stroke: #ffffff;
    stroke-width: 1;
    pointer-events: auto;
    transition: opacity 0.2s ease, stroke 0.2s ease, stroke-width 0.2s ease, fill-opacity 0.2s ease;
  }

  .station-overlay circle:focus {
    outline: none;
  }

  .station-overlay circle.selected {
    stroke: #ffffff;
    stroke-width: 2.25;
    fill-opacity: 0.8;
  }

  .station-overlay circle:focus-visible {
    outline: none;
    stroke: #ffffff;
    stroke-width: 2.25;
  }

  .station-overlay:has(circle.selected) circle:not(.selected) {
    opacity: 0.3;
  }

  .station-overlay path {
    pointer-events: auto;
  }

  .legend {
    display: flex;
    gap: 1px;
    margin-block: 0.75rem 0;
  }

  .legend > div {
    flex: 1;
    background: var(--color);
    color: #ffffff;
    font-size: 0.82rem;
    font-weight: 600;
    padding: 0.35rem 0.65rem;
    text-shadow: 0 1px 1px rgba(0, 0, 0, 0.25);
  }

  .legend > div:first-child {
    text-align: left;
  }

  .legend > div:nth-child(2) {
    text-align: center;
  }

  .legend > div:last-child {
    text-align: right;
  }

  .warning {
    margin: 0.75rem 0 0;
    padding: 0.65rem 0.75rem;
    border: 1px solid #f59e0b;
    border-radius: 0.375rem;
    background: #fffbeb;
    color: #92400e;
    font-size: 0.95rem;
  }

  @media (max-width: 700px) {
    .time-filter {
      margin-left: 0;
      width: 100%;
    }

    .time-filter input {
      width: 100%;
    }

    .legend {
      flex-direction: column;
      gap: 0.35rem;
    }

    .legend > div {
      text-align: left;
    }

    #map {
      min-height: 24rem;
    }
  }
</style>
