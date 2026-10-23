/**
 * Built-in multilingual subject lexicon.
 *
 * This is evidence vocabulary, not a fixed taxonomy: discovery only turns a
 * concept into a category when the user's collection supports it, and users
 * can rename, merge, split, reject or replace anything. Concepts power the
 * offline baseline, synonym/alias detection, and AI candidate shortlists.
 *
 * Term syntax: lowercase folded words or phrases; a trailing "*" matches a
 * token prefix ("astrophys*"). Terms marked generic in GENERIC_TERMS carry
 * less weight (e.g. programming language names that appear in many subjects).
 */

export interface Concept {
  key: string;
  label: string;
  labelFa: string;
  /** Parent concept key; undefined for top-level areas. */
  parent?: string;
  definition: string;
  terms: string[];
  /** Domains (or domain suffixes) that strongly indicate this subject. */
  domains?: string[];
  /** Terms that argue against this concept when present (disambiguation). */
  negative?: string[];
}

const C = (
  key: string,
  label: string,
  labelFa: string,
  parent: string | undefined,
  definition: string,
  terms: string[],
  domains: string[] = [],
  negative: string[] = [],
): Concept => (parent ? { key, label, labelFa, parent, definition, terms, domains, negative } : { key, label, labelFa, definition, terms, domains, negative });

export const LEXICON: Concept[] = [
  // ───────── Computing & Software
  C('computing', 'Computing & Software', 'رایانش و نرم‌افزار', undefined, 'Programming, software engineering, systems and computer technology.',
    ['software', 'computer', 'computing', 'programming', 'developer', 'coding', 'نرم افزار', 'برنامه نویسی', 'رایانه', 'کامپیوتر', 'برمجة', 'حاسوب'],
    ['stackoverflow.com', 'stackexchange.com', 'dev.to', 'developer.mozilla.org', 'docs.microsoft.com', 'learn.microsoft.com']),
  C('prog-lang', 'Programming Languages', 'زبان‌های برنامه‌نویسی', 'computing', 'Languages, syntax, compilers, interpreters and language tutorials.',
    ['python', 'javascript', 'typescript', 'java', 'c++', 'c#', 'rust', 'golang', 'go language', 'haskell', 'fortran', 'julia lang', 'kotlin', 'swift', 'ruby', 'perl', 'php', 'lisp', 'scheme', 'ocaml', 'compiler*', 'interpreter', 'syntax', 'pep', 'tutorial', 'cpp', 'stdlib', 'pypi', 'npm', 'crate', 'pandas', 'numpy'],
    ['python.org', 'rust-lang.org', 'go.dev', 'typescriptlang.org', 'isocpp.org', 'cppreference.com', 'pypi.org', 'npmjs.com', 'crates.io', 'realpython.com']),
  C('algorithms', 'Algorithms & Data Structures', 'الگوریتم‌ها و ساختمان داده', 'computing', 'Algorithm design, complexity and data structures.',
    ['algorithm*', 'data structure*', 'complexity', 'sorting', 'graph theory algorithm', 'dynamic programming', 'leetcode', 'competitive programming', 'الگوریتم', 'ساختمان داده'],
    ['leetcode.com', 'codeforces.com', 'geeksforgeeks.org']),
  C('software-eng', 'Software Engineering', 'مهندسی نرم‌افزار', 'computing', 'Architecture, testing, version control, DevOps and development practice.',
    ['git', 'github actions', 'ci/cd', 'devops', 'testing', 'unit test', 'refactoring', 'design pattern*', 'architecture', 'microservice*', 'api design', 'docker', 'kubernetes', 'ide', 'vscode', 'neovim', 'vim', 'emacs', 'agile', 'scrum', 'code review'],
    ['git-scm.com', 'docker.com', 'kubernetes.io', 'martinfowler.com']),
  C('os', 'Operating Systems & Linux', 'سیستم‌عامل و لینوکس', 'computing', 'Operating systems, Linux distributions, shells and system administration.',
    ['linux', 'fedora', 'ubuntu', 'debian', 'arch linux', 'kernel', 'bash', 'shell', 'systemd', 'windows 11', 'macos', 'sysadmin', 'grub', 'wayland', 'gnome', 'kde', 'لینوکس', 'سیستم عامل'],
    ['kernel.org', 'archlinux.org', 'fedoraproject.org', 'ubuntu.com', 'debian.org', 'askubuntu.com']),
  C('hardware-net', 'Hardware & Networking', 'سخت‌افزار و شبکه', 'computing', 'Computer hardware, GPUs, networking and protocols.',
    ['gpu', 'cpu', 'motherboard', 'nvidia', 'cuda', 'ssd', 'raspberry pi', 'arduino', 'network*', 'tcp', 'dns', 'router', 'ethernet', 'wifi', 'fpga', 'سخت افزار', 'شبکه'],
    ['anandtech.com', 'tomshardware.com', 'developer.nvidia.com']),
  C('security', 'Cybersecurity', 'امنیت سایبری', 'computing', 'Security engineering, cryptography, vulnerabilities and privacy.',
    ['security', 'cybersecurity', 'infosec', 'vulnerabilit*', 'exploit', 'malware', 'pentest*', 'penetration testing', 'cryptograph*', 'encryption', 'owasp', 'cve', 'ctf', 'zero trust', 'امنیت', 'رمزنگاری'],
    ['owasp.org', 'krebsonsecurity.com', 'portswigger.net', 'cve.mitre.org']),
  C('cloud', 'Cloud & Parallel Computing', 'رایانش ابری و موازی', 'computing', 'Cloud platforms, HPC, distributed and parallel computing.',
    ['aws', 'azure', 'gcp', 'google cloud', 'cloud computing', 'serverless', 'terraform', 'hpc', 'parallel computing', 'mpi', 'openmp', 'distributed system*', 'supercomput*', 'رایانش ابری'],
    ['aws.amazon.com', 'cloud.google.com', 'azure.microsoft.com']),
  C('integer-factoring', 'Integer Factoring & Computational Number Theory', 'تجزیه اعداد صحیح', 'math', 'Factoring algorithms and tools (GNFS, ECM, yafu) and primality computation.',
    ['factoring', 'factorization', 'gnfs', 'nfs', 'ecm', 'yafu', 'cado-nfs', 'msieve', 'ggnfs', 'mersenne', 'primality', 'prime factor*', 'pari/gp', 'pari gp', 'gimps'],
    ['mersenneforum.org', 'mersenne.org', 'factordb.com']),

  // ───────── AI & Data
  C('ai-data', 'AI & Data Science', 'هوش مصنوعی و علم داده', undefined, 'Machine learning, AI systems, data engineering and analytics.',
    ['artificial intelligence', 'ai', 'data science', 'هوش مصنوعی', 'علم داده', 'الذكاء الاصطناعي'], ['kaggle.com', 'paperswithcode.com']),
  C('ml', 'Machine Learning', 'یادگیری ماشین', 'ai-data', 'Statistical learning, deep learning, neural networks and training methods.',
    ['machine learning', 'ml', 'deep learning', 'neural network*', 'pytorch', 'tensorflow', 'scikit-learn', 'sklearn', 'transformer model', 'cnn', 'reinforcement learning', 'gradient descent', 'یادگیری ماشین', 'یادگیری عمیق', 'شبکه عصبی', 'تعلم الآلة'],
    ['pytorch.org', 'tensorflow.org', 'scikit-learn.org', 'distill.pub']),
  C('genai', 'Generative AI & Agents', 'هوش مصنوعی مولد و عامل‌ها', 'ai-data', 'Large language models, prompting, agents and generative media.',
    ['llm', 'llms', 'large language model*', 'gpt', 'chatgpt', 'claude', 'gemini', 'anthropic', 'openai', 'prompt engineering', 'prompting', 'rag', 'agent*', 'agentic', 'langchain', 'diffusion model*', 'stable diffusion', 'midjourney', 'hugging face', 'huggingface', 'mcp', 'fine-tuning', 'fine tuning', 'هوش مصنوعی مولد', 'مدل زبانی'],
    ['huggingface.co', 'openai.com', 'anthropic.com', 'ai.google.dev', 'ollama.com']),
  C('data-eng', 'Data Engineering & Databases', 'مهندسی داده و پایگاه داده', 'ai-data', 'Databases, SQL, data pipelines and storage.',
    ['database*', 'sql', 'postgresql', 'postgres', 'mysql', 'sqlite', 'mongodb', 'redis', 'etl', 'data pipeline*', 'data warehouse', 'spark', 'kafka', 'duckdb', 'پایگاه داده'],
    ['postgresql.org', 'mongodb.com', 'sqlite.org', 'duckdb.org']),
  C('analytics-viz', 'Analytics & Visualization', 'تحلیل و مصورسازی داده', 'ai-data', 'Data analysis, dashboards, charts and visualization tools.',
    ['data visualization', 'visualisation', 'dataviz', 'dashboard*', 'tableau', 'power bi', 'matplotlib', 'plotly', 'd3.js', 'd3', 'jupyter', 'notebook*', 'data analysis', 'مصورسازی'],
    ['observablehq.com', 'tableau.com', 'jupyter.org']),

  // ───────── Mathematics
  C('math', 'Mathematics & Statistics', 'ریاضیات و آمار', undefined, 'Pure and applied mathematics, statistics and mathematical software.',
    ['mathematics', 'math', 'maths', 'mathematical', 'theorem', 'proof', 'ریاضی', 'ریاضیات', 'رياضيات'],
    ['mathworld.wolfram.com', 'math.stackexchange.com', 'mathoverflow.net', 'ams.org', 'maa.org', 'oeis.org', 'planetmath.org']),
  C('number-theory', 'Number Theory', 'نظریه اعداد', 'math', 'Primes, Diophantine equations, modular arithmetic and analytic number theory.',
    ['number theory', 'prime*', 'modular arithmetic', 'diophantine', 'riemann hypothesis', 'zeta function', 'elliptic curve*', 'congruence*', 'نظریه اعداد', 'اعداد اول'],
    ['oeis.org', 'primes.utm.edu', 't5k.org']),
  C('algebra', 'Algebra', 'جبر', 'math', 'Linear and abstract algebra, groups, rings and fields.',
    ['algebra', 'linear algebra', 'matrix', 'matrices', 'group theory', 'ring theory', 'galois', 'eigenvalue*', 'abstract algebra', 'جبر', 'جبر خطی']),
  C('geometry-topology', 'Geometry & Topology', 'هندسه و توپولوژی', 'math', 'Euclidean and differential geometry, topology and spherical trigonometry.',
    ['geometry', 'topology', 'manifold*', 'differential geometry', 'spherical trigonometry', 'trigonometry', 'polyhedr*', 'هندسه', 'توپولوژی', 'مثلثات']),
  C('analysis', 'Analysis & Calculus', 'آنالیز و حسابان', 'math', 'Calculus, real/complex analysis, differential equations and numerical methods.',
    ['calculus', 'real analysis', 'complex analysis', 'differential equation*', 'ode', 'pde', 'fourier', 'numerical method*', 'numerical analysis', 'integral*', 'series expansion', 'حسابان', 'آنالیز', 'معادلات دیفرانسیل']),
  C('prob-stats', 'Probability & Statistics', 'احتمال و آمار', 'math', 'Probability theory, statistics, inference and stochastic processes.',
    ['probability', 'statistics', 'statistical', 'bayesian', 'regression', 'stochastic', 'hypothesis test*', 'monte carlo', 'آمار', 'احتمال'],
    ['stats.stackexchange.com', 'r-project.org']),
  C('math-software', 'Mathematical Software', 'نرم‌افزار ریاضی', 'math', 'Computer algebra systems, solvers and math libraries.',
    ['mathematica', 'wolfram', 'matlab', 'maple', 'sagemath', 'sage math', 'octave', 'sympy', 'computer algebra', 'latex', 'tex', 'overleaf', 'gnuplot'],
    ['wolfram.com', 'sagemath.org', 'mathworks.com', 'overleaf.com', 'ctan.org', 'tex.stackexchange.com']),

  // ───────── Astronomy
  C('astronomy', 'Astronomy & Space Science', 'نجوم و علوم فضایی', undefined, 'Astronomy, astrophysics, celestial mechanics, space missions and astronomical computation.',
    ['astronomy', 'astronomical', 'astronomer*', 'astrophys*', 'telescope*', 'observatory', 'celestial', 'planetarium', 'space science', 'nasa', 'esa', 'نجوم', 'ستاره شناسی', 'اخترشناسی', 'رصدخانه', 'علم الفلك', 'فلك'],
    ['nasa.gov', 'esa.int', 'iau.org', 'aas.org', 'adsabs.harvard.edu', 'ui.adsabs.harvard.edu', 'skyandtelescope.org', 'eso.org', 'noirlab.edu', 'stsci.edu'],
    ['horoscope', 'astrology', 'zodiac sign*', 'طالع']),
  C('celestial-mech', 'Celestial Mechanics & Astrodynamics', 'مکانیک سماوی و اخترپویایی', 'astronomy', 'Orbits, n-body dynamics, perturbations, orbit determination and spaceflight dynamics.',
    ['celestial mechanics', 'orbital mechanics', 'astrodynamics', 'orbit*', 'kepler*', 'n-body', 'perturbation*', 'two-body', 'three-body', 'lambert problem', 'trajectory', 'spacecraft dynamics', 'mean motion', 'osculating', 'precession', 'nutation', 'tle', 'sgp4', 'poliastro', 'مکانیک سماوی', 'مدار', 'مداری'],
    ['celestrak.org', 'celestrak.com']),
  C('ephemerides', 'Ephemerides & Reference Systems', 'زیج‌ها و دستگاه‌های مرجع', 'astronomy', 'Planetary ephemerides (VSOP, DE), coordinate/reference frames and positional astronomy.',
    ['ephemeris', 'ephemerides', 'vsop87', 'vsop', 'jpl de', 'de440', 'de430', 'horizons', 'spice', 'spiceypy', 'reference frame*', 'icrs', 'icrf', 'fk5', 'equinox', 'ecliptic', 'right ascension', 'declination', 'astrometry', 'apparent position', 'topocentric', 'geocentric', 'heliocentric', 'skyfield', 'astropy', 'sofa', 'erfa', 'novas', 'meeus', 'astronomical algorithms', 'زیج', 'مختصات'],
    ['ssd.jpl.nasa.gov', 'naif.jpl.nasa.gov', 'iausofa.org', 'aa.usno.navy.mil', 'imcce.fr', 'rhodesmill.org', 'astropy.org']),
  C('observational', 'Observational Astronomy', 'نجوم رصدی', 'astronomy', 'Observing, telescopes, astrophotography, sky charts and occultations.',
    ['observing', 'astrophotography', 'telescope*', 'eyepiece', 'star chart*', 'sky chart', 'stellarium', 'occultation*', 'eclipse*', 'transit*', 'meteor*', 'variable star*', 'deep sky', 'messier', 'light pollution', 'رصد', 'تلسکوپ', 'کسوف', 'خسوف', 'اختفا'],
    ['stellarium.org', 'cloudynights.com', 'occultations.org', 'iota-es.de', 'heavens-above.com', 'timeanddate.com/eclipse']),
  C('solar-system', 'Solar System', 'منظومه شمسی', 'astronomy', 'Planets, moons, asteroids, comets and the Sun.',
    ['solar system', 'planet*', 'moon', 'lunar', 'mars', 'jupiter', 'saturn', 'venus', 'mercury planet', 'asteroid*', 'comet*', 'minor planet*', 'sun', 'solar', 'منظومه شمسی', 'سیاره', 'ماه', 'خورشید'],
    ['minorplanetcenter.net', 'mpc.cfa.harvard.edu'], ['solar panel*', 'solar energy']),
  C('astrophysics', 'Astrophysics & Cosmology', 'اخترفیزیک و کیهان‌شناسی', 'astronomy', 'Stars, galaxies, cosmology and high-energy astrophysics.',
    ['astrophys*', 'cosmology', 'galax*', 'black hole*', 'neutron star*', 'supernova*', 'exoplanet*', 'dark matter', 'dark energy', 'big bang', 'stellar evolution', 'کیهان شناسی', 'اخترفیزیک', 'کهکشان'],
    ['arxiv.org/list/astro-ph']),
  C('astro-software', 'Astronomical Data & Software', 'داده و نرم‌افزار نجومی', 'astronomy', 'Astronomy catalogs, archives, libraries and computation tools.',
    ['astropy', 'skyfield', 'pyephem', 'ephem', 'gaia', 'simbad', 'vizier', 'catalog*', 'catalogue*', 'fits', 'virtual observatory', 'swiss ephemeris', 'astronomy software', 'astronomy library'],
    ['simbad.u-strasbg.fr', 'vizier.cds.unistra.fr', 'cds.unistra.fr', 'gea.esac.esa.int', 'heasarc.gsfc.nasa.gov']),

  // ───────── Calendars & Timekeeping
  C('calendars', 'Calendars & Timekeeping', 'گاه‌شماری و زمان‌سنجی', undefined, 'Calendar systems, calendrical computation, chronology and time scales.',
    ['calendar*', 'calendrical', 'calendrics', 'timekeeping', 'گاه شماری', 'گاهشماری', 'تقویم', 'تقويم'],
    ['calendars.wikia.org', 'webexhibits.org/calendars']),
  C('cal-algorithms', 'Calendrical Algorithms & Conversion', 'الگوریتم‌ها و تبدیل تقویم', 'calendars', 'Algorithms and tools for converting dates between calendars, day counts and Julian dates.',
    ['calendar conversion', 'date conversion', 'convert date*', 'date converter', 'calendrical calculations', 'julian day', 'julian date', 'jdn', 'day of week', 'computus', 'easter date', 'reingold', 'dershowitz', 'leap year algorithm', 'تبدیل تاریخ', 'تبدیل تقویم', 'روز ژولیانی'],
    ['fourmilab.ch/documents/calendar']),
  C('cal-systems', 'Calendar Systems', 'دستگاه‌های گاه‌شماری', 'calendars', 'Specific calendars: Gregorian, Julian, Persian/Solar Hijri, Islamic, Hebrew, Chinese, Mayan and others.',
    ['gregorian', 'julian calendar', 'persian calendar', 'solar hijri', 'jalali', 'hijri', 'islamic calendar', 'hebrew calendar', 'jewish calendar', 'chinese calendar', 'mayan calendar', 'coptic', 'ethiopian calendar', 'zoroastrian calendar', 'yazdgerdi', 'lunisolar', 'هجری شمسی', 'جلالی', 'هجری قمری', 'تقویم ایرانی', 'یزدگردی', 'التقويم الهجري']),
  C('chronology', 'Historical Chronology', 'تاریخ‌گذاری و گاه‌نگاری تاریخی', 'calendars', 'Dating historical events, eras, regnal years and chronological tables.',
    ['chronology', 'historical chronology', 'era', 'eras', 'regnal', 'dating system*', 'chronological table*', 'synchronism*', 'گاه نگاری', 'سال شمار', 'تاریخ گذاری']),
  C('time-scales', 'Time Scales & Precise Time', 'مقیاس‌های زمانی', 'calendars', 'UTC, TAI, TT, UT1, Delta T, leap seconds, time zones and clocks.',
    ['utc', 'tai', 'ut1', 'terrestrial time', 'delta t', 'δt', 'leap second*', 'time scale*', 'time zone*', 'timezone*', 'tz database', 'atomic clock*', 'ntp', 'sidereal time', 'equation of time', 'مقیاس زمانی', 'ثانیه کبیسه'],
    ['iers.org', 'hpiers.obspm.fr', 'tf.nist.gov', 'iana.org/time-zones']),
  C('religious-time', 'Crescent Visibility & Religious Timekeeping', 'رؤیت هلال و اوقات شرعی', 'calendars', 'Lunar crescent visibility, prayer times, qibla and religious calendar practice (studied neutrally).',
    ['crescent visibility', 'crescent', 'hilal', 'moon sighting', 'new moon visibility', 'prayer times', 'prayer time*', 'qibla', 'ramadan', 'yallop', 'odeh', 'رؤیت هلال', 'رویت هلال', 'هلال', 'اوقات شرعی', 'قبله', 'رؤية الهلال', 'مواقيت الصلاة'],
    ['moonsighting.com', 'icoproject.org', 'astronomycenter.net']),

  // ───────── Earth & Physical sciences
  C('earth-physical', 'Earth & Physical Sciences', 'علوم زمین و علوم فیزیکی', undefined, 'Geoscience, geodesy, physics, chemistry and electronics.',
    ['science', 'physical science*', 'علوم'], []),
  C('geodesy-gis', 'Geodesy & GIS', 'ژئودزی و سامانه اطلاعات مکانی', 'earth-physical', 'Geodesy, map projections, GNSS, coordinate systems and GIS software.',
    ['geodesy', 'geodetic', 'gis', 'qgis', 'arcgis', 'gnss', 'gps', 'map projection*', 'projection*', 'wgs84', 'ellipsoid', 'datum', 'epsg', 'proj', 'gdal', 'shapefile', 'geospatial', 'ژئودزی', 'نقشه برداری', 'سامانه اطلاعات جغرافیایی'],
    ['qgis.org', 'esri.com', 'epsg.io', 'gdal.org', 'proj.org', 'ngs.noaa.gov']),
  C('geography', 'Geography & Mapping', 'جغرافیا و نقشه', 'earth-physical', 'Geography, maps, atlases and place information.',
    ['geography', 'atlas', 'map', 'maps', 'cartograph*', 'gazetteer', 'topographic', 'openstreetmap', 'جغرافیا', 'نقشه', 'اطلس'],
    ['openstreetmap.org', 'geonames.org']),
  C('geophysics', 'Geology & Geophysics', 'زمین‌شناسی و ژئوفیزیک', 'earth-physical', 'Geology, seismology, volcanology, climate and earth systems.',
    ['geology', 'geologic*', 'geophysic*', 'seismolog*', 'earthquake*', 'volcano*', 'tectonic*', 'mineral*', 'climate', 'meteorolog*', 'weather', 'oceanograph*', 'زمین شناسی', 'زلزله', 'آب و هوا'],
    ['usgs.gov', 'noaa.gov', 'iris.edu']),
  C('physics', 'Physics', 'فیزیک', 'earth-physical', 'Classical, quantum, relativity and applied physics.',
    ['physics', 'quantum', 'relativity', 'mechanics', 'thermodynamic*', 'electromagnet*', 'optics', 'particle physics', 'فیزیک', 'کوانتوم', 'نسبیت', 'فيزياء'],
    ['aps.org', 'physicsworld.com', 'physics.stackexchange.com']),
  C('chemistry', 'Chemistry', 'شیمی', 'earth-physical', 'Chemistry, materials and chemical data.',
    ['chemistry', 'chemical', 'molecule*', 'periodic table', 'organic chemistry', 'شیمی'], ['pubchem.ncbi.nlm.nih.gov', 'acs.org', 'rsc.org']),
  C('electronics', 'Electronics', 'الکترونیک', 'earth-physical', 'Circuits, components, embedded electronics and radio.',
    ['electronics', 'circuit*', 'resistor', 'capacitor', 'oscilloscope', 'pcb', 'soldering', 'ham radio', 'amateur radio', 'sdr', 'الکترونیک'], ['allaboutcircuits.com', 'eevblog.com', 'hackaday.com']),

  // ───────── Life sciences & health
  C('life-health', 'Life Sciences & Health', 'علوم زیستی و سلامت', undefined, 'Biology, ecology, genetics, medicine, nutrition and exercise.',
    ['biology', 'health', 'زیست شناسی', 'سلامت'], ['ncbi.nlm.nih.gov', 'pubmed.ncbi.nlm.nih.gov']),
  C('biology', 'Biology & Ecology', 'زیست‌شناسی و بوم‌شناسی', 'life-health', 'Biology, ecology, evolution, botany and zoology.',
    ['biology', 'ecology', 'evolution', 'botany', 'zoology', 'species', 'biodiversity', 'cell biology', 'زیست شناسی', 'بوم شناسی'], ['inaturalist.org', 'gbif.org']),
  C('genetics', 'Genetics & Genomics', 'ژنتیک', 'life-health', 'Genetics, genomics, DNA and ancestry science.',
    ['genetic*', 'genom*', 'dna', 'haplogroup*', 'gene*', 'crispr', 'ژنتیک'], ['23andme.com', 'ensembl.org']),
  C('medicine', 'Medicine', 'پزشکی', 'life-health', 'Medical reference, conditions and treatments (classified neutrally).',
    ['medicine', 'medical', 'disease*', 'symptom*', 'treatment', 'clinical', 'pharmac*', 'پزشکی', 'بیماری', 'درمان'], ['mayoclinic.org', 'nih.gov', 'who.int', 'medlineplus.gov', 'webmd.com']),
  C('nutrition-exercise', 'Nutrition & Exercise', 'تغذیه و ورزش', 'life-health', 'Diet, nutrition, fitness and exercise.',
    ['nutrition', 'diet', 'recipe*', 'fitness', 'exercise', 'workout', 'yoga', 'running', 'تغذیه', 'ورزش', 'رژیم'], ['examine.com']),

  // ───────── History & culture
  C('history-culture', 'History, Archaeology & Cultural Studies', 'تاریخ، باستان‌شناسی و مطالعات فرهنگی', undefined, 'History, archaeology, ancient civilizations and cultural heritage.',
    ['history', 'historical', 'historian', 'تاریخ', 'تاريخ'], []),
  C('ancient', 'Ancient Civilizations', 'تمدن‌های باستانی', 'history-culture', 'Ancient Near East, Egypt, Mesopotamia, Greece, Rome and other early civilizations.',
    ['ancient', 'antiquity', 'mesopotamia*', 'babylon*', 'sumer*', 'assyria*', 'egypt*', 'pharaoh*', 'cuneiform', 'hieroglyph*', 'achaemenid*', 'sasanian*', 'sassanid*', 'parthian*', 'elam*', 'roman empire', 'ancient greece', 'باستان', 'هخامنشی', 'ساسانی', 'اشکانی', 'ایلام', 'بابل'],
    ['ancient.eu', 'worldhistory.org']),
  C('iranian-studies', 'Iranian Studies', 'ایران‌شناسی', 'history-culture', 'History, culture and scholarship of Iran and the Persianate world.',
    ['iranian studies', 'iranica', 'persia', 'persian empire', 'iran history', 'ایران شناسی', 'تاریخ ایران', 'ایرانیکا'],
    ['iranicaonline.org', 'iranicaonline.com']),
  C('archaeology', 'Archaeology', 'باستان‌شناسی', 'history-culture', 'Archaeological research, excavations and artifacts.',
    ['archaeolog*', 'archeolog*', 'excavation*', 'artifact*', 'artefact*', 'باستان شناسی', 'کاوش'], []),
  C('historical-sources', 'Historical Sources & Manuscripts', 'منابع تاریخی و نسخ خطی', 'history-culture', 'Primary sources, manuscripts, digitized archives and historical texts.',
    ['manuscript*', 'archive*', 'primary source*', 'digitized', 'codex', 'inscription*', 'نسخه خطی', 'نسخ خطی', 'مخطوط'],
    ['archive.org', 'wdl.org', 'gallica.bnf.fr', 'digital.library']),
  C('heritage', 'Cultural Heritage & Museums', 'میراث فرهنگی و موزه‌ها', 'history-culture', 'Museums, heritage sites and cultural institutions.',
    ['museum*', 'heritage', 'unesco', 'cultural heritage', 'موزه', 'میراث فرهنگی'], ['metmuseum.org', 'britishmuseum.org', 'whc.unesco.org']),

  // ───────── Languages & literature
  C('lang-lit', 'Languages & Literature', 'زبان و ادبیات', undefined, 'Linguistics, language learning, dictionaries, literature and writing.',
    ['language', 'literature', 'زبان', 'ادبیات', 'لغة', 'أدب'], []),
  C('linguistics', 'Linguistics', 'زبان‌شناسی', 'lang-lit', 'Linguistics, etymology, phonetics and historical languages.',
    ['linguistic*', 'etymolog*', 'phonetic*', 'phonolog*', 'morpholog*', 'syntax tree', 'proto-indo-european', 'indo-european', 'zend', 'avestan', 'pahlavi', 'middle persian', 'old persian', 'زبان شناسی', 'ریشه شناسی', 'پهلوی', 'اوستایی'],
    ['etymonline.com', 'glottolog.org', 'wals.info']),
  C('persian-lit', 'Persian Language & Literature', 'زبان و ادبیات فارسی', 'lang-lit', 'Persian language, poetry and literature (e.g. Hafez, Rumi, Ferdowsi).',
    ['persian language', 'persian literature', 'persian poetry', 'farsi', 'hafez', 'hafiz', 'rumi', 'molana', 'saadi', 'ferdowsi', 'shahnameh', 'khayyam', 'attar', 'nezami', 'ادبیات فارسی', 'زبان فارسی', 'حافظ', 'مولانا', 'سعدی', 'فردوسی', 'شاهنامه', 'خیام', 'عطار', 'نظامی', 'شعر', 'غزل', 'دیوان'],
    ['ganjoor.net', 'vajehyab.com']),
  C('other-languages', 'Language Learning', 'یادگیری زبان', 'lang-lit', 'Learning and resources for other languages (English, Arabic, French, German...).',
    ['learn english', 'english grammar', 'arabic language', 'learn arabic', 'french', 'german', 'spanish', 'language learning', 'ielts', 'toefl', 'duolingo', 'grammar', 'vocabulary', 'آموزش زبان', 'زبان انگلیسی', 'زبان عربی'],
    ['duolingo.com', 'bbc.co.uk/learningenglish']),
  C('dictionaries', 'Dictionaries & Corpora', 'واژه‌نامه‌ها و پیکره‌ها', 'lang-lit', 'Dictionaries, thesauri, lexicons and text corpora.',
    ['dictionary', 'dictionaries', 'thesaurus', 'lexicon', 'glossary', 'corpus', 'corpora', 'concordance', 'لغت نامه', 'لغتنامه', 'فرهنگ لغت', 'واژه نامه', 'دهخدا', 'معجم', 'قاموس'],
    ['merriam-webster.com', 'oxfordlearnersdictionaries.com', 'wiktionary.org', 'abadis.ir', 'vajehyab.com', 'dehkhoda.ut.ac.ir']),
  C('translation', 'Translation', 'ترجمه', 'lang-lit', 'Translation tools and translation studies.',
    ['translation', 'translate', 'translator', 'ترجمه', 'مترجم', 'ترجمة'], ['deepl.com', 'translate.google.com']),
  C('writing', 'Writing & Literature', 'نوشتن و ادبیات', 'lang-lit', 'Writing craft, style guides, books and world literature.',
    ['writing', 'style guide', 'novel*', 'poetry', 'poem*', 'fiction', 'author*', 'essay*', 'نویسندگی', 'رمان', 'داستان'], ['gutenberg.org', 'goodreads.com', 'poetryfoundation.org']),

  // ───────── Philosophy & religion
  C('philosophy-religion', 'Philosophy, Religions & Belief Systems', 'فلسفه، ادیان و باورها', undefined, 'Philosophy, comparative religion, sacred texts and esoteric traditions, studied neutrally.',
    ['philosophy', 'religion*', 'فلسفه', 'دین', 'ادیان', 'فلسفة', 'دين'], ['plato.stanford.edu', 'iep.utm.edu']),
  C('philosophy', 'Philosophy', 'فلسفه', 'philosophy-religion', 'Philosophy, logic, ethics and the history of ideas.',
    ['philosoph*', 'ethics', 'epistemolog*', 'metaphysic*', 'logic', 'stoic*', 'existentialism', 'فلسفه', 'منطق', 'اخلاق'], ['plato.stanford.edu', 'iep.utm.edu']),
  C('comparative-religion', 'Comparative Religion', 'ادیان تطبیقی', 'philosophy-religion', 'Study of religions, theology and religious history.',
    ['religion*', 'religious studies', 'theology', 'islam*', 'christian*', 'judaism', 'zoroastrian*', 'buddhis*', 'hindu*', 'mithra*', 'manichae*', 'mazdak*', 'gnostic*', 'زرتشت*', 'ادیان', 'مذهب', 'اسلام', 'مسیحیت', 'یهودیت', 'میترا', 'مانی'],
    ['avesta.org']),
  C('primary-texts', 'Sacred & Primary Texts', 'متون مقدس و متون اصلی', 'philosophy-religion', 'Scriptures and classical primary texts and their translations.',
    ['quran', 'koran', 'bible', 'torah', 'avesta', 'gathas', 'vedas', 'upanishad*', 'hadith', 'tafsir', 'قرآن', 'انجیل', 'تورات', 'اوستا', 'گاتها', 'حدیث', 'تفسیر'],
    ['quran.com', 'tanzil.net', 'biblegateway.com', 'sacred-texts.com']),
  C('esoteric', 'Astrology & Esoteric Traditions', 'طالع‌بینی و سنت‌های باطنی', 'philosophy-religion', 'Astrology, occultism, mysticism and esoteric traditions (classified as topics, not endorsed).',
    ['astrology', 'astrological', 'horoscope*', 'zodiac sign*', 'natal chart', 'birth chart', 'tarot', 'occult', 'occultism', 'esoteric*', 'hermetic*', 'kabbalah', 'numerology', 'alchemy', 'mysticism', 'sufism', 'طالع بینی', 'طالع', 'احکام نجوم', 'فال', 'عرفان', 'تصوف', 'علوم غریبه', 'التنجيم'],
    ['astro.com', 'astro-seek.com'], ['occultation*', 'ephemeris']),

  // ───────── Arts & media
  C('arts-media', 'Arts & Media', 'هنر و رسانه', undefined, 'Visual arts, photography, film, music and design.',
    ['art', 'arts', 'هنر', 'فن'], []),
  C('visual-arts', 'Visual Arts', 'هنرهای تجسمی', 'arts-media', 'Painting, drawing, calligraphy, miniature and art history.',
    ['painting', 'drawing', 'sketch*', 'calligraphy', 'miniature', 'art history', 'illustration', 'نقاشی', 'خوشنویسی', 'نگارگری', 'مینیاتور', 'طراحی'], ['wikiart.org']),
  C('photography', 'Photography', 'عکاسی', 'arts-media', 'Photography technique, cameras and photo editing.',
    ['photography', 'photographer', 'camera*', 'lens', 'lightroom', 'darktable', 'عکاسی', 'دوربین'], ['dpreview.com', '500px.com', 'flickr.com']),
  C('film', 'Film & Video', 'سینما و ویدیو', 'arts-media', 'Cinema, documentaries, TV and video production.',
    ['film', 'movie*', 'cinema', 'documentary', 'documentaries', 'video editing', 'davinci resolve', 'سینما', 'فیلم', 'مستند'], ['imdb.com', 'letterboxd.com']),
  C('music', 'Music', 'موسیقی', 'arts-media', 'Music theory, instruments, recordings and audio production.',
    ['music', 'musical', 'song*', 'guitar', 'piano', 'setar', 'tar', 'santur', 'dastgah', 'music theory', 'موسیقی', 'آهنگ', 'دستگاه', 'سه تار', 'سنتور'], ['musescore.com', 'imslp.org', 'bandcamp.com']),
  C('design', 'Design', 'طراحی', 'arts-media', 'Graphic, UI/UX and typography design.',
    ['design', 'ui design', 'ux', 'typography', 'font*', 'figma', 'icon*', 'color palette', 'graphic design', 'logo', 'طراحی گرافیک', 'فونت'], ['figma.com', 'dribbble.com', 'behance.net', 'fonts.google.com']),

  // ───────── Education
  C('education', 'Education & Teaching', 'آموزش و تدریس', undefined, 'Pedagogy, course creation, tutoring and educational platforms.',
    ['education', 'educational', 'teaching', 'آموزش', 'تدریس', 'تعليم'], []),
  C('pedagogy', 'Pedagogy & Learning Science', 'آموزش‌شناسی', 'education', 'Teaching methods, learning science and instructional design.',
    ['pedagogy', 'pedagogical', 'instructional design', 'learning science', 'teaching method*', 'curriculum', 'lesson plan*', 'classroom', 'assessment', 'روش تدریس', 'برنامه درسی']),
  C('course-creation', 'Course Creation', 'تولید دوره آموزشی', 'education', 'Creating and publishing online courses and educational content.',
    ['course creation', 'create a course', 'online course creation', 'lms', 'teachable', 'thinkific', 'kajabi', 'udemy instructor', 'course platform', 'screencast', 'تولید محتوای آموزشی']),
  C('tutoring', 'Tutoring', 'تدریس خصوصی', 'education', 'Tutoring practice and tutoring platforms.',
    ['tutoring', 'tutor', 'tutors', 'wyzant', 'preply', 'تدریس خصوصی'], ['wyzant.com', 'preply.com', 'varsitytutors.com']),
  C('edu-platforms', 'Educational Platforms & MOOCs', 'سکوهای آموزشی', 'education', 'Course providers and open courseware (classify a course by its subject first).',
    ['mooc', 'moocs', 'coursera', 'edx', 'khan academy', 'udemy', 'opencourseware', 'ocw', 'course', 'courses', 'lecture*', 'دوره', 'درس'],
    ['coursera.org', 'edx.org', 'khanacademy.org', 'udemy.com', 'ocw.mit.edu', 'brilliant.org']),

  // ───────── Business, finance, real estate
  C('business-finance', 'Business & Finance', 'کسب‌وکار و مالی', undefined, 'Economics, business operations, personal finance and markets.',
    ['business', 'finance', 'financial', 'کسب و کار', 'مالی', 'اقتصاد'], []),
  C('economics', 'Economics', 'اقتصاد', 'business-finance', 'Economics and economic data.', ['economics', 'economy', 'economic*', 'inflation', 'gdp', 'اقتصاد'], ['fred.stlouisfed.org', 'imf.org', 'worldbank.org']),
  C('business-ops', 'Business Operations', 'عملیات کسب‌وکار', 'business-finance', 'Starting and running a business, marketing, legal forms and productivity.',
    ['startup*', 'entrepreneur*', 'marketing', 'seo', 'small business', 'llc', 'invoice*', 'crm', 'productivity', 'project management', 'بازاریابی', 'کارآفرینی'], ['hubspot.com', 'sba.gov']),
  C('personal-finance', 'Personal Finance & Investing', 'مالی شخصی و سرمایه‌گذاری', 'business-finance', 'Budgeting, taxes, retirement, stocks and markets.',
    ['personal finance', 'budget*', 'tax', 'taxes', 'retirement', '401k', 'ira', 'invest*', 'stock*', 'etf*', 'bond*', 'trading', 'crypto*', 'bitcoin', 'mortgage calculator', 'بورس', 'سرمایه گذاری', 'مالیات'],
    ['investopedia.com', 'bogleheads.org', 'irs.gov', 'morningstar.com', 'finance.yahoo.com']),

  C('real-estate', 'Real Estate', 'املاک و مستغلات', undefined, 'Real-estate practice, property data, listings, licensing and professional tools.',
    ['real estate', 'realtor*', 'realty', 'property', 'properties', 'listing*', 'mls', 'escrow', 'appraisal', 'zoning', 'landlord', 'rental', 'home buying', 'املاک', 'مسکن', 'خرید خانه', 'عقارات'],
    ['zillow.com', 'redfin.com', 'realtor.com', 'trulia.com', 'loopnet.com', 'nar.realtor', 'dre.ca.gov', 'car.org']),
  C('re-practice', 'Real Estate Practice & Licensing', 'حرفه و مجوز املاک', 'real-estate', 'Agent practice, licensing exams, contracts, disclosures and brokerage.',
    ['real estate license', 'licensing exam', 'broker*', 'brokerage', 'agent', 'disclosure*', 'purchase agreement', 'escrow', 'transaction', 'commission', 'dre', 'nar', 'continuing education'],
    ['dre.ca.gov', 'nar.realtor', 'car.org']),
  C('property-data', 'Property Data & Listings', 'داده و آگهی املاک', 'real-estate', 'Listings, valuations, parcel/tax records and market data.',
    ['listing*', 'mls', 'comps', 'comparable*', 'parcel', 'assessor', 'property tax', 'valuation', 'zestimate', 'market report', 'housing market', 'آگهی'],
    ['zillow.com', 'redfin.com', 'realtor.com', 'trulia.com', 'propertyshark.com']),
  C('re-tools', 'Real Estate Tools & Software', 'ابزارهای املاک', 'real-estate', 'Transaction management, CRM, e-signature and mortgage tools for practitioners.',
    ['transaction management', 'docusign', 'dotloop', 'skyslope', 'zipforms', 'mortgage calculator', 'crm', 'lead generation', 'showing*'],
    ['dotloop.com', 'skyslope.com', 'docusign.com']),

  // ───────── Everyday life
  C('everyday', 'Everyday Life & Interests', 'زندگی روزمره و علایق', undefined, 'Travel, outdoors, games, shopping and personal utilities.',
    [], []),
  C('travel', 'Travel', 'سفر', 'everyday', 'Trips, destinations, transport and accommodation.', ['travel', 'trip', 'flight*', 'hotel*', 'airbnb', 'visa', 'itinerary', 'سفر', 'گردشگری', 'هتل'], ['tripadvisor.com', 'booking.com', 'airbnb.com', 'expedia.com', 'lonelyplanet.com']),
  C('outdoors', 'Outdoors', 'طبیعت‌گردی', 'everyday', 'Hiking, camping, parks and outdoor activities.', ['hiking', 'hike', 'camping', 'trail*', 'national park*', 'backpacking', 'climbing', 'کوهنوردی', 'طبیعت گردی'], ['alltrails.com', 'nps.gov', 'recreation.gov']),
  C('chess-games', 'Chess & Games', 'شطرنج و بازی', 'everyday', 'Chess, board games and video games.', ['chess', 'opening*', 'endgame', 'stockfish', 'lichess', 'board game*', 'video game*', 'game', 'games', 'شطرنج', 'بازی'], ['lichess.org', 'chess.com', 'chessbase.com', 'boardgamegeek.com', 'steampowered.com']),
  C('shopping', 'Shopping', 'خرید', 'everyday', 'Stores, products and deals.', ['shop', 'shopping', 'buy', 'deal*', 'coupon*', 'price*', 'store', 'cart', 'خرید', 'فروشگاه'], ['amazon.com', 'ebay.com', 'etsy.com', 'aliexpress.com', 'walmart.com', 'costco.com', 'bestbuy.com', 'digikala.com']),
  C('utilities', 'Personal Utilities', 'ابزارهای شخصی', 'everyday', 'Email, banking portals, utilities, government services and personal accounts.', ['account', 'my account', 'bank*', 'utility', 'utilities', 'bill pay', 'dmv', 'passport', 'insurance', 'webmail', 'ایمیل', 'بانک'], ['mail.google.com', 'outlook.live.com', 'usps.com', 'ups.com', 'fedex.com']),
  C('news', 'News & Current Affairs', 'اخبار', 'everyday', 'News outlets and current affairs (topic-neutral).', ['news', 'breaking', 'headline*', 'اخبار', 'خبر', 'أخبار'], ['bbc.com', 'bbc.co.uk', 'nytimes.com', 'reuters.com', 'apnews.com', 'theguardian.com', 'cnn.com', 'npr.org', 'aljazeera.com']),
];

/** Platform domains host unrelated subjects; they never imply a subject alone. */
export const PLATFORM_DOMAINS = new Set([
  'github.com', 'gitlab.com', 'bitbucket.org', 'youtube.com', 'youtu.be', 'vimeo.com', 'wikipedia.org', 'wikimedia.org', 'wikiwand.com',
  'drive.google.com', 'docs.google.com', 'sites.google.com', 'dropbox.com', 'onedrive.live.com', 'medium.com', 'substack.com',
  'reddit.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'linkedin.com', 'pinterest.com', 'quora.com',
  'archive.org', 'web.archive.org', 'academia.edu', 'researchgate.net', 'arxiv.org', 'scholar.google.com', 'books.google.com',
  'amazon.com', 'google.com', 'bing.com', 'duckduckgo.com', 'blogspot.com', 'wordpress.com', 'notion.so', 'scribd.com', 'slideshare.net',
  'telegram.me', 't.me', 'aparat.com', 'soundcloud.com', 'spotify.com', 'tiktok.com', 'jstor.org', 'sciencedirect.com', 'springer.com',
  'link.springer.com', 'wiley.com', 'tandfonline.com', 'semanticscholar.org', 'doi.org', 'sci-hub.se', 'libgen.is', 'z-library.sk',
]);

/** Terms that appear across many subjects; scored at reduced weight. */
export const GENERIC_TERMS = new Set([
  'python', 'javascript', 'java', 'c++', 'c#', 'rust', 'julia lang', 'r', 'tutorial', 'course', 'courses', 'lecture*', 'software', 'data', 'map',
  'maps', 'game', 'games', 'design', 'history', 'science', 'language', 'art', 'arts', 'calendar*', 'orbit*', 'agent', 'agent*', 'transit*',
  'sun', 'solar', 'moon', 'planet*', 'catalog*', 'catalogue*', 'fits', 'projection*', 'proj', 'store', 'price*', 'deal*', 'buy', 'shop', 'account',
  'utility', 'listing*', 'property', 'properties', 'archive*', 'era', 'eras', 'notebook*', 'dashboard*', 'mechanics', 'logic', 'integral*', 'icon*',
  'font*', 'logo', 'gene*', 'opening*', 'trail*', 'tar', 'translate', 'proof', 'theorem', 'series expansion', 'network*', 'ide', 'claude', 'gemini',
  'agent', 'transaction', 'commission', 'broker*', 'crm', 'showing*', 'comps', 'tax', 'bond*', 'stock*', 'invest*', 'grammar', 'vocabulary', 'french',
  'german', 'spanish', 'ai', 'ml', 'gpt', 'rag', 'mcp', 'era', 'tex', 'latex', 'nar', 'dre', 'ode', 'pde', 'sql', 'gis', 'gps', 'dns', 'tcp', 'iso',
  'تقویم', 'تاریخ', 'زبان', 'هنر', 'علوم', 'آموزش', 'درس', 'دوره', 'ماه', 'خورشید', 'سیاره', 'مدار', 'نقشه', 'بازی', 'خرید', 'شعر', 'دیوان',
]);

/** Resource-type facet vocabulary (kept separate from subject folders). */
export const RESOURCE_TYPES: Array<{ key: string; label: string; terms: string[]; domains?: string[]; pathHints?: RegExp }> = [
  { key: 'paper', label: 'Paper', terms: ['paper', 'journal', 'preprint', 'proceedings', 'doi', 'abstract', 'مقاله'], domains: ['arxiv.org', 'doi.org', 'jstor.org', 'sciencedirect.com', 'springer.com', 'link.springer.com', 'researchgate.net', 'academia.edu', 'semanticscholar.org', 'adsabs.harvard.edu', 'ui.adsabs.harvard.edu', 'tandfonline.com', 'wiley.com', 'ieeexplore.ieee.org', 'dl.acm.org'], pathHints: /\.pdf$|\/abs\/|\/doi\//i },
  { key: 'book', label: 'Book', terms: ['book', 'books', 'ebook', 'textbook', 'handbook', 'کتاب'], domains: ['books.google.com', 'gutenberg.org', 'goodreads.com', 'oreilly.com', 'manning.com', 'libgen.is'] },
  { key: 'course', label: 'Course', terms: ['course', 'courses', 'lecture', 'lectures', 'syllabus', 'mooc', 'class', 'دوره', 'درس'], domains: ['coursera.org', 'edx.org', 'khanacademy.org', 'udemy.com', 'ocw.mit.edu'] },
  { key: 'software', label: 'Software / Code', terms: ['library', 'package', 'sdk', 'api', 'source code', 'repository', 'download', 'release', 'cli', 'plugin', 'extension', 'نرم افزار'], domains: ['github.com', 'gitlab.com', 'bitbucket.org', 'pypi.org', 'npmjs.com', 'crates.io', 'sourceforge.net'] },
  { key: 'dataset', label: 'Dataset', terms: ['dataset', 'datasets', 'data set', 'catalog', 'catalogue', 'database', 'csv', 'download data'], domains: ['kaggle.com', 'data.gov', 'zenodo.org', 'figshare.com'] },
  { key: 'calculator', label: 'Calculator / Tool', terms: ['calculator', 'converter', 'calculate', 'online tool', 'generator', 'simulator', 'محاسبه', 'تبدیل'] },
  { key: 'reference', label: 'Reference', terms: ['documentation', 'docs', 'reference', 'manual', 'wiki', 'encyclopedia', 'glossary', 'faq', 'specification', 'مرجع', 'دانشنامه'], domains: ['wikipedia.org', 'developer.mozilla.org', 'plato.stanford.edu', 'britannica.com'] },
  { key: 'video', label: 'Video', terms: ['video', 'videos', 'watch', 'playlist', 'webinar', 'ویدیو', 'فیلم'], domains: ['youtube.com', 'youtu.be', 'vimeo.com', 'aparat.com'] },
  { key: 'forum', label: 'Forum / Q&A', terms: ['forum', 'thread', 'discussion', 'community', 'q&a', 'انجمن'], domains: ['reddit.com', 'stackoverflow.com', 'stackexchange.com', 'quora.com', 'mersenneforum.org', 'cloudynights.com'] },
  { key: 'article', label: 'Article / Blog', terms: ['blog', 'article', 'post', 'news', 'وبلاگ'], domains: ['medium.com', 'substack.com', 'dev.to', 'blogspot.com', 'wordpress.com'] },
];

/** Geography facet terms (places mentioned, never the user's identity). */
export const GEOGRAPHY_TERMS: Array<{ key: string; label: string; terms: string[] }> = [
  { key: 'iran', label: 'Iran', terms: ['iran', 'iranian', 'persia', 'persian', 'tehran', 'isfahan', 'shiraz', 'ایران', 'تهران', 'اصفهان', 'شیراز'] },
  { key: 'middle-east', label: 'Middle East', terms: ['middle east', 'iraq', 'arab*', 'egypt', 'mesopotamia', 'خاورمیانه', 'عراق'] },
  { key: 'usa', label: 'United States', terms: ['usa', 'united states', 'california', 'texas', 'new york', 'los angeles', 'san francisco', 'us federal', 'آمریکا'] },
  { key: 'europe', label: 'Europe', terms: ['europe', 'european', 'uk', 'britain', 'germany', 'france', 'italy', 'greece', 'اروپا'] },
  { key: 'asia', label: 'Asia', terms: ['china', 'india', 'japan', 'korea', 'central asia', 'آسیا', 'چین', 'هند'] },
];

export const CONCEPTS_BY_KEY = new Map(LEXICON.map((c) => [c.key, c]));

export function conceptChildren(key: string | undefined): Concept[] {
  return LEXICON.filter((c) => c.parent === key);
}

export function conceptPath(key: string): Concept[] {
  const out: Concept[] = [];
  for (let c = CONCEPTS_BY_KEY.get(key); c; c = c.parent ? CONCEPTS_BY_KEY.get(c.parent) : undefined) out.unshift(c);
  return out;
}
