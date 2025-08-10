/*
 Minimal GLTFLoader (subset) for offline use
 -------------------------------------------------
 Supports: .glb (binary glTF 2.0) files with:
  - Single scene
  - Buffer / bufferViews / accessors
  - Meshes with triangle primitives (mode 4) using POSITION (required), NORMAL (optional), TEXCOORD_0 (ignored), indices (optional)
  - Node transforms (translation / rotation / scale)
 Not supported (will be ignored): skins, animations, materials beyond base color, PBR params, textures, cameras, morph targets, extensions.

 This is NOT the full THREE.GLTFLoader. For production, use the official loader from three.js.

 MIT License (applies to this file)
 Copyright (c) 2025
*/

(function(global){
  if(!global.THREE){ console.error('THREE not found: load three.min.js before GLTFLoader.js'); return; }

  class GLTFLoader {
    constructor(manager){ this.manager = manager || global.THREE.DefaultLoadingManager; }

    load(url, onLoad, onProgress, onError){
      fetch(url).then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.arrayBuffer(); })
        .then(ab=>{ try{ const gltf = this.parse(ab, url); onLoad && onLoad(gltf); }catch(e){ if(onError) onError(e); else console.error(e); } })
        .catch(err=>{ if(onError) onError(err); else console.error(err); });
    }

    parse(arrayBuffer, url){
      const dv = new DataView(arrayBuffer);
      // GLB Header
      const magic = dv.getUint32(0, true); // 'glTF' = 0x46546C67
      if(magic !== 0x46546C67){ throw new Error('Not a GLB file'); }
      const version = dv.getUint32(4, true); if(version!==2) throw new Error('Only glTF 2.0 supported');
      const length  = dv.getUint32(8, true); if(length !== arrayBuffer.byteLength) console.warn('GLB length mismatch');
      let offset = 12;
      let json = null; let bin = null;
      while(offset < length){
        const chunkLen = dv.getUint32(offset, true); offset += 4;
        const chunkType = dv.getUint32(offset, true); offset += 4;
        const chunkData = arrayBuffer.slice(offset, offset+chunkLen);
        offset += chunkLen;
        if(chunkType === 0x4E4F534A){ // JSON
          json = JSON.parse(new TextDecoder().decode(new Uint8Array(chunkData)));
        } else if(chunkType === 0x004E4942){ // BIN
          bin = chunkData;
        }
      }
      if(!json) throw new Error('Missing JSON chunk');
      const ctx = { json, bin, url, THREE: global.THREE };
      const scene = this._buildScene(ctx);
      return { scene, scenes:[scene], parser:this, asset: json.asset||{}, json };
    }

    _buildScene(ctx){
      const {json, THREE} = ctx;
      const buffers = this._buildBuffers(ctx);
      const accessors = this._buildAccessors(ctx, buffers);
  // Images & textures (optional)
  ctx.images = this._buildImages(ctx, buffers);
  ctx.textures = this._buildTextures(ctx);
      const meshes = (json.meshes||[]).map(m=> this._buildMesh(ctx, m, accessors));
      const nodes = (json.nodes||[]).map((n,i)=> this._buildNode(ctx, n, meshes));
      // Link children
      (json.nodes||[]).forEach((n,i)=>{ if(n.children){ n.children.forEach(cid=>{ if(nodes[cid]) nodes[i].add(nodes[cid]); }); } });
      // Scene root
      const scene = new THREE.Group(); scene.name = 'GLBScene';
      const sceneDef = (json.scenes && json.scenes[json.scene||0]);
      if(sceneDef && sceneDef.nodes){ sceneDef.nodes.forEach(id=>{ if(nodes[id]) scene.add(nodes[id]); }); }
      return scene;
    }

    _buildBuffers(ctx){
      const {json, bin} = ctx;
      // We only support single binary buffer (or embedded) referencing BIN chunk
      return (json.buffers||[]).map((b,i)=>{
        if(i===0 && bin) return bin; // first buffer is BIN chunk
        throw new Error('Only single BIN buffer supported in this minimal loader');
      });
    }

    _buildAccessors(ctx, buffers){
      const {json} = ctx;
      const views = (json.bufferViews||[]).map(v=>{
        const buffer = buffers[v.buffer];
        return buffer.slice(v.byteOffset||0, (v.byteOffset||0)+(v.byteLength||0));
      });
      return (json.accessors||[]).map(acc=>{
        const view = views[acc.bufferView];
        const compTypeMap = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
        const Ctor = compTypeMap[acc.componentType]; if(!Ctor) throw new Error('Unsupported componentType');
        const typeSizeMap = { SCALAR:1, VEC2:2, VEC3:3, VEC4:4, MAT4:16, MAT3:9, MAT2:4 };
        const numComp = typeSizeMap[acc.type]; if(!numComp) throw new Error('Unsupported type '+acc.type);
        const bytesPerComp = Ctor.BYTES_PER_ELEMENT;
        const offset = acc.byteOffset||0;
        const length = acc.count * numComp;
        const arr = new Ctor(view, offset, length);
        return { array: arr, itemSize: numComp, normalized: !!acc.normalized, componentType: acc.componentType, count: acc.count, type: acc.type };
      });
    }

    _buildMesh(ctx, meshDef, accessors){
      const {THREE, json} = ctx;
      const group = new THREE.Group(); group.name = meshDef.name || 'mesh';
      const matDefs = json.materials || [];
      (meshDef.primitives||[]).forEach((prim, idx)=>{
        if(prim.mode && prim.mode !== 4){ console.warn('Primitive mode not TRIANGLES, skipped'); return; }
        const geometry = new THREE.BufferGeometry();
        if(!prim.attributes || prim.attributes.POSITION==null){ console.warn('Primitive missing POSITION'); return; }
        // POSITION
        const posAcc = accessors[prim.attributes.POSITION];
        geometry.setAttribute('position', new THREE.BufferAttribute(posAcc.array, posAcc.itemSize, posAcc.normalized));
        // NORMAL
        if(prim.attributes.NORMAL!=null){ const nAcc = accessors[prim.attributes.NORMAL]; geometry.setAttribute('normal', new THREE.BufferAttribute(nAcc.array, nAcc.itemSize, nAcc.normalized)); }
        // VERTEX COLOR
        let usesVertexColor = false;
        if(prim.attributes.COLOR_0!=null){
          const cAcc = accessors[prim.attributes.COLOR_0];
          // If colors not normalized but integer, convert to float 0..1 (glTF may omit normalized flag)
          let colorArray = cAcc.array;
          if(!cAcc.normalized){
            if(cAcc.componentType === 5121){ // UNSIGNED_BYTE
              const f = new Float32Array(colorArray.length);
              for(let i=0;i<colorArray.length;i++){ f[i] = colorArray[i]/255; }
              colorArray = f;
            } else if(cAcc.componentType === 5123){ // UNSIGNED_SHORT
              const f = new Float32Array(colorArray.length);
              for(let i=0;i<colorArray.length;i++){ f[i] = colorArray[i]/65535; }
              colorArray = f;
            }
          }
          geometry.setAttribute('color', new THREE.BufferAttribute(colorArray, cAcc.itemSize, false));
          usesVertexColor = true;
        }
        // INDICES
        if(prim.indices!=null){ const iAcc = accessors[prim.indices]; geometry.setIndex(new THREE.BufferAttribute(iAcc.array, 1, false)); }
        geometry.computeBoundingSphere();
        // MATERIAL
        let matOptions = { color: 0x2194f3, metalness:0.1, roughness:0.85 };
        if(prim.material!=null && matDefs[prim.material]){
          const mdef = matDefs[prim.material];
          if(mdef.pbrMetallicRoughness){
            const p = mdef.pbrMetallicRoughness;
            if(Array.isArray(p.baseColorFactor)){
              const r=(p.baseColorFactor[0]||0)*255, g=(p.baseColorFactor[1]||0)*255, b=(p.baseColorFactor[2]||0)*255;
              matOptions.color = (r<<16)|(g<<8)|b;
              if(p.baseColorFactor[3] != null && p.baseColorFactor[3] < 1){ matOptions.transparent = true; matOptions.opacity = p.baseColorFactor[3]; }
            }
            // baseColorTexture
            if(p.baseColorTexture && p.baseColorTexture.index!=null && ctx.textures){
              const tex = ctx.textures[p.baseColorTexture.index];
              if(tex){ matOptions.map = tex; matOptions.color = 0xffffff; }
            }
            if(p.metallicFactor!=null) matOptions.metalness = p.metallicFactor;
            if(p.roughnessFactor!=null) matOptions.roughness = p.roughnessFactor;
          }
          if(mdef.emissiveFactor && Array.isArray(mdef.emissiveFactor)){
            const er=(mdef.emissiveFactor[0]||0)*255, eg=(mdef.emissiveFactor[1]||0)*255, eb=(mdef.emissiveFactor[2]||0)*255;
            matOptions.emissive = (er<<16)|(eg<<8)|eb;
          }
          if(mdef.doubleSided) matOptions.side = THREE.DoubleSide;
          if(mdef.alphaMode === 'BLEND'){ matOptions.transparent = true; if(matOptions.opacity==null) matOptions.opacity = 0.9; }
        }
        if(usesVertexColor){ matOptions.vertexColors = true; }
        const material = new THREE.MeshStandardMaterial(matOptions);
        if(material.map){ material.map.encoding = THREE.sRGBEncoding; material.needsUpdate = true; }
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = (meshDef.name||'mesh')+'_'+idx;
        group.add(mesh);
      });
      return group;
    }

    _buildNode(ctx, nodeDef, meshes){
      const {THREE} = ctx;
      const obj = new THREE.Group();
      obj.name = nodeDef.name || 'node';
      if(nodeDef.mesh!=null){ obj.add(meshes[nodeDef.mesh].clone()); }
      if(nodeDef.translation){ obj.position.fromArray(nodeDef.translation); }
      if(nodeDef.scale){ obj.scale.fromArray(nodeDef.scale); }
      if(nodeDef.rotation){ obj.quaternion.set(nodeDef.rotation[0], nodeDef.rotation[1], nodeDef.rotation[2], nodeDef.rotation[3]); }
      return obj;
    }

    _buildImages(ctx){
      const {json, bin, THREE, url} = ctx;
      if(!json.images) return [];
      const basePath = url ? url.substring(0, url.lastIndexOf('/')+1) : '';
      return json.images.map(img=>{
        if(img.bufferView!=null){
          const bv = json.bufferViews[img.bufferView];
          const start = (bv.byteOffset||0);
            const end = start + (bv.byteLength||0);
          const slice = bin.slice(start, end);
          const blob = new Blob([slice], {type: img.mimeType||'image/png'});
          const objectURL = URL.createObjectURL(blob);
          return { url: objectURL, mimeType: img.mimeType, _objectURL: objectURL };
        } else if(img.uri){
          // Data URI or external
          if(/^data:/.test(img.uri)) return { url: img.uri, mimeType: (img.mimeType||'') };
          return { url: basePath + img.uri, mimeType: img.mimeType };
        }
        return null;
      });
    }

    _buildTextures(ctx){
      const {json, images, THREE} = ctx;
      if(!json.textures) return [];
      const loader = new THREE.TextureLoader();
      return json.textures.map(tex=>{
        if(tex.source==null) return null;
        const img = images[tex.source];
        if(!img) return null;
        const t = loader.load(img.url);
        if(tex.sampler!=null && json.samplers){
          const s = json.samplers[tex.sampler];
          if(s){
            // Set wrapping
            const wrapMap = { 33071: THREE.ClampToEdgeWrapping, 33648: THREE.MirroredRepeatWrapping, 10497: THREE.RepeatWrapping };
            if(s.wrapS!=null && wrapMap[s.wrapS]) t.wrapS = wrapMap[s.wrapS];
            if(s.wrapT!=null && wrapMap[s.wrapT]) t.wrapT = wrapMap[s.wrapT];
            // Set filtering
            const filterMap = { 9728: THREE.NearestFilter, 9729: THREE.LinearFilter, 9984: THREE.NearestMipmapNearestFilter, 9985: THREE.LinearMipmapNearestFilter, 9986: THREE.NearestMipmapLinearFilter, 9987: THREE.LinearMipmapLinearFilter };
            if(s.magFilter!=null && filterMap[s.magFilter]) t.magFilter = filterMap[s.magFilter];
            if(s.minFilter!=null && filterMap[s.minFilter]) t.minFilter = filterMap[s.minFilter];
          }
        }
        t.flipY = false; // glTF convention
        return t;
      });
    }
  }

  global.THREE.GLTFLoader = GLTFLoader;
})(typeof window!=='undefined'? window : globalThis);
