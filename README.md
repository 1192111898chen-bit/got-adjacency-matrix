# Game of Thrones Adjacency Matrix

An interactive D3 visualization of character co-occurrences in *A Storm of Swords*.

## Data

107 characters and 352 undirected relationships in the included CSV files. Edge weights count names appearing within 15 words of each other; they do not encode friendship or hostility.

Source: https://github.com/melaniewalsh/sample-social-network-datasets/tree/master/sample-datasets/game-of-thrones

## Run locally

Run `python3 -m http.server 8000` from this directory and open http://localhost:8000/ . CSV loading requires HTTP rather than opening index.html directly.

## GitHub Pages

Publish from the main branch, repository root. Intended URL (available after deployment): https://1192111898chen-bit.github.io/got-adjacency-matrix/

D3 is bundled locally in d3.min.js. The visualization preserves its original dataset attribution in the page footer.
