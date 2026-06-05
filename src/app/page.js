'use client';

import { useEffect, useState, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { motion, AnimatePresence } from 'framer-motion';
import { Target, Trophy, Flame, AlertCircle } from 'lucide-react';

const ADJECTIVES = ['Alpha', 'Neuro', 'Synapse', 'Cortex', 'Quantum', 'Logic'];
const NOUNS = ['Thinker', 'Sage', 'Solver', 'Dynamo', 'Brain', 'Vector'];

// Desaturated, non-vibrant, non-radium, earthy/neutral colors (No blue, purple, red, or gradients)
const COLORS = [
  '#4E5E50', // Muted Forest/Sage
  '#A08C75', // Warm Sand/Taupe
  '#A3704C', // Terracotta/Clay
  '#5B6E7A', // Muted Slate/Steel
  '#8F754E', // Muted Ochre/Gold
  '#4A4A4A', // Charcoal
];

export default function BrainGridGame() {
  const [tiles, setTiles] = useState([]);
  const [gameState, setGameState] = useState({ current_target: 1 });
  const [user, setUser] = useState({ name: '', color: '' });
  const [score, setScore] = useState(0);
  const [errorFlash, setErrorFlash] = useState(null);
  const [gridSize, setGridSize] = useState(10);
  const [isResetting, setIsResetting] = useState(false);

  // Fetch match data helper
  const pullInitialMatchData = async () => {
    const { data: tilesData } = await supabase.from('brain_tiles').select('*').order('id', { ascending: true });
    const { data: gameData } = await supabase.from('brain_game').select('*').eq('id', 1).single();
    
    if (tilesData) setTiles(tilesData);
    if (gameData) setGameState(gameData);
  };

  // Initialize identity and board state configuration
  useEffect(() => {
    let storedName = null;
    let storedColor = null;
    try {
      storedName = localStorage.getItem('synapse_name');
      storedColor = localStorage.getItem('synapse_color');
    } catch (e) {
      console.error(e);
    }

    if (!storedName) {
      storedName = `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${NOUNS[Math.floor(Math.random() * NOUNS.length)]}`;
      try {
        localStorage.setItem('synapse_name', storedName);
      } catch (e) {}
    }
    if (!storedColor) {
      storedColor = COLORS[Math.floor(Math.random() * COLORS.length)];
      try {
        localStorage.setItem('synapse_color', storedColor);
      } catch (e) {}
    }

    setUser({ name: storedName, color: storedColor });
    pullInitialMatchData();
  }, []);

  // Handle Real-time WebSocket Synchronizations
  useEffect(() => {
    const systemChannel = supabase
      .channel('realtime-brain-sync')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'brain_tiles' }, (payload) => {
        setTiles((prev) => prev.map((t) => (t.id === payload.new.id ? payload.new : t)));
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'brain_tiles' }, () => {
        pullInitialMatchData();
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'brain_tiles' }, () => {
        pullInitialMatchData();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'brain_game' }, (payload) => {
        if (payload.new) setGameState(payload.new);
        else pullInitialMatchData();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(systemChannel);
    };
  }, []);

  // Process Tile Interaction & Handle Conflicts
  const handleTileSelection = async (tile) => {
    // Return early if tile is claimed or incorrect or game is finished
    if (tile.owner_color || gameState.current_target > tiles.length) return;

    if (tile.value !== gameState.current_target) {
      setErrorFlash(tile.id);
      setTimeout(() => setErrorFlash(null), 600);
      return;
    }

    const nextTargetValue = gameState.current_target + 1;

    // Optimistic UI updates to provide instant local execution feel
    setTiles((prev) => prev.map((t) => t.id === tile.id ? { ...t, owner_name: user.name, owner_color: user.color } : t));
    setGameState((prev) => ({ ...prev, current_target: nextTargetValue }));
    setScore((prev) => prev + 10);

    // Write to DB sequentially.
    const { error: tileErr } = await supabase
      .from('brain_tiles')
      .update({ owner_name: user.name, owner_color: user.color })
      .eq('id', tile.id)
      .is('owner_color', null);

    const { error: gameErr } = await supabase
      .from('brain_game')
      .update({ current_target: nextTargetValue })
      .eq('id', 1)
      .eq('current_target', gameState.current_target);

    // Rollback changes if a race condition collision occurred with another user
    if (tileErr || gameErr) {
      await pullInitialMatchData();
      setScore((prev) => Math.max(0, prev - 10));
    }
  };

  // Reset the game and start fresh with a selected grid size
  const handleStartFreshGame = async (size) => {
    setIsResetting(true);
    try {
      // 1. Wipe all existing tiles
      await supabase
        .from('brain_tiles')
        .delete()
        .neq('id', 0);

      // 2. Generate new math tiles
      const totalTiles = size * size;
      const newTiles = [];
      for (let v = 1; v <= totalTiles; v++) {
        let r = Math.floor(Math.random() * 10 + 1);
        let expr = '';
        if (Math.random() > 0.5) {
          expr = `${v + r} - ${r}`;
        } else {
          r = Math.floor(Math.random() * (v - 1) + 1);
          if (v === 1) {
            expr = '5 - 4';
          } else {
            expr = `${v - r} + ${r}`;
          }
        }
        newTiles.push({ value: v, expression: expr });
      }

      // Shuffle tiles so they are not sequential on the grid
      const shuffledTiles = newTiles
        .map((value) => ({ value, sort: Math.random() }))
        .sort((a, b) => a.sort - b.sort)
        .map(({ value }) => value);

      // 3. Bulk insert tiles
      await supabase
        .from('brain_tiles')
        .insert(shuffledTiles);

      // 4. Reset target to 1
      await supabase
        .from('brain_game')
        .update({ current_target: 1 })
        .eq('id', 1);

      // Refresh locally
      await pullInitialMatchData();
    } catch (err) {
      console.error('Failed to reset game:', err);
    } finally {
      setIsResetting(false);
    }
  };

  // Compile realtime stats rankings
  const leaderboard = useMemo(() => {
    const tracking = {};
    tiles.forEach((t) => {
      if (t.owner_color) {
        tracking[t.owner_color] = {
          color: t.owner_color,
          name: t.owner_name,
          count: (tracking[t.owner_color]?.count || 0) + 1,
        };
      }
    });
    return Object.values(tracking).sort((a, b) => b.count - a.count).slice(0, 4);
  }, [tiles]);

  // Determine the winner
  const winner = useMemo(() => {
    if (tiles.length === 0 || gameState.current_target <= tiles.length) return null;
    const tracking = {};
    tiles.forEach((t) => {
      if (t.owner_name) {
        tracking[t.owner_name] = {
          name: t.owner_name,
          color: t.owner_color,
          count: (tracking[t.owner_name]?.count || 0) + 1
        };
      }
    });
    const sorted = Object.values(tracking).sort((a, b) => b.count - a.count);
    return sorted[0] || null;
  }, [tiles, gameState.current_target]);

  const isFinished = tiles.length > 0 && gameState.current_target > tiles.length;

  // Compile grid size grid columns class statically to ensure compilation
  const gridColsClass = {
    5: 'grid-cols-5',
    6: 'grid-cols-6',
    7: 'grid-cols-7',
    8: 'grid-cols-8',
    9: 'grid-cols-9',
    10: 'grid-cols-10',
  }[Math.sqrt(tiles.length)] || 'grid-cols-10';

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center p-4 md:p-8 font-sans select-none">
      
      {/* Typographic Header */}
      <header className="w-full max-w-6xl flex flex-col md:flex-row justify-between items-center gap-6 border-b border-foreground/10 pb-6 mb-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-4xl font-serif italic tracking-wide text-foreground font-black">
            Synapse Sprint
          </h1>
          <p className="text-xs font-mono uppercase tracking-wider text-foreground/60">
            Node Identity: <span className="font-bold underline" style={{ color: user.color }}>{user.name}</span>
          </p>
        </div>

        {/* Global Target Banner */}
        <div className="flex items-center gap-6 border border-foreground/10 px-6 py-3 bg-foreground/[0.02]">
          <div className="flex items-center gap-2">
            <Target className="w-4 h-4 text-foreground/75" />
            <span className="text-[10px] font-mono tracking-widest text-foreground/60 uppercase">Target Objective:</span>
          </div>
          <div className="text-3xl font-serif italic text-foreground font-bold px-2">
            {gameState.current_target <= tiles.length ? gameState.current_target : 'Finished'}
          </div>
        </div>

        {/* Score & Select Layout */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 border border-foreground/10 px-4 py-2 bg-foreground/[0.01]">
            <Flame className="w-4 h-4 text-foreground/70" />
            <span className="text-xs font-mono text-foreground/80">Score: {score} pts</span>
          </div>

          <div className="flex items-center gap-2 border border-foreground/10 px-3 py-2 bg-foreground/[0.01]">
            <span className="text-xs font-mono text-foreground/60 uppercase tracking-wide">Grid:</span>
            <select
              value={gridSize}
              onChange={(e) => setGridSize(Number(e.target.value))}
              disabled={isFinished}
              className="bg-transparent text-xs font-mono text-foreground focus:outline-none cursor-pointer border-none"
            >
              {[5, 6, 7, 8, 9, 10].map(s => (
                <option key={s} value={s} className="bg-background text-foreground">
                  {s}x{s}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      {/* Main Grid Viewport Arena */}
      <main className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-4 gap-8 items-start">
        
        {/* Arena Grid Blocks */}
        <div className="lg:col-span-3 border border-foreground/10 p-4 md:p-6 bg-foreground/[0.005]">
          <div className={`grid ${gridColsClass} gap-2`}>
            {tiles.map((tile) => {
              const isError = errorFlash === tile.id;
              return (
                <motion.button
                  key={tile.id}
                  onClick={() => handleTileSelection(tile)}
                  disabled={tile.owner_color !== null || gameState.current_target > tiles.length}
                  animate={isError ? { x: [-4, 4, -4, 4, 0] } : {}}
                  transition={{ duration: 0.3 }}
                  whileHover={{ scale: tile.owner_color ? 1 : 1.04 }}
                  whileTap={{ scale: 0.98 }}
                  className="aspect-square w-full flex flex-col items-center justify-center border border-foreground/10 p-1 relative transition-all group overflow-hidden cursor-pointer"
                  style={{
                    backgroundColor: tile.owner_color ? `${tile.owner_color}1a` : isError ? '#ffebeb' : 'transparent',
                    borderColor: tile.owner_color ? tile.owner_color : isError ? '#ef4444' : 'currentColor',
                    opacity: tile.owner_color ? 0.9 : 1,
                  }}
                >
                  {tile.owner_color ? (
                    // Captured Block Appearance Layout
                    <div className="flex flex-col items-center justify-center">
                      <span className="text-sm font-serif font-black" style={{ color: tile.owner_color }}>{tile.value}</span>
                      <span className="text-[9px] font-mono opacity-80 uppercase tracking-tighter truncate max-w-[55px]" style={{ color: tile.owner_color }}>
                        {tile.owner_name.split(' ')[0]}
                      </span>
                    </div>
                  ) : (
                    // Active Expression Appearance Layout
                    <span className="text-xs font-mono font-medium text-foreground/70 group-hover:text-foreground transition-colors">
                      {tile.expression}
                    </span>
                  )}
                </motion.button>
              );
            })}
          </div>
        </div>

        {/* Real-time Insights Side-Panel */}
        <div className="flex flex-col gap-6 w-full">
          {/* Faction Ranking List */}
          <div className="border border-foreground/10 p-5 bg-foreground/[0.005]">
            <h3 className="text-xs font-mono font-bold tracking-widest uppercase text-foreground/60 flex items-center gap-2 mb-4 border-b border-foreground/10 pb-2">
              <Trophy className="w-4 h-4 text-foreground/70" /> Faction Ranking
            </h3>
            <div className="flex flex-col gap-2">
              <AnimatePresence>
                {leaderboard.map((team, index) => (
                  <motion.div
                    key={team.color}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="flex items-center justify-between p-3 border-b border-foreground/5 bg-foreground/[0.01]"
                  >
                    <div className="flex items-center gap-3 overflow-hidden">
                      <span className="text-xs font-mono font-bold text-foreground/40">#{index + 1}</span>
                      <div className="h-2.5 w-2.5 rounded-none" style={{ backgroundColor: team.color }} />
                      <span className="text-xs font-serif font-semibold truncate" style={{ color: team.color }}>{team.name}</span>
                    </div>
                    <span className="text-xs font-mono px-2 py-0.5 border border-foreground/10 text-foreground/80">
                      {team.count} cells
                    </span>
                  </motion.div>
                ))}
              </AnimatePresence>
              {leaderboard.length === 0 && (
                <div className="text-center py-6 border border-dashed border-foreground/10 text-xs text-foreground/40 italic flex flex-col items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-foreground/30" /> Search the equations and trace target #1!
                </div>
              )}
            </div>
          </div>

          {/* Quick Manual Restart (For Convenience) */}
          <button
            onClick={() => handleStartFreshGame(gridSize)}
            disabled={isResetting}
            className="w-full border border-foreground hover:bg-foreground hover:text-background text-foreground font-mono uppercase tracking-wider py-3 text-xs transition-colors duration-200"
          >
            {isResetting ? 'Resetting Board...' : 'Manual Reset Board'}
          </button>
        </div>
      </main>

      {/* Typographic Winner Modal Overlay */}
      {isFinished && (
        <div className="fixed inset-0 bg-background/95 flex items-center justify-center z-50 p-4">
          <div className="bg-background border border-foreground/20 max-w-md w-full p-8 text-center flex flex-col items-center gap-6">
            <h2 className="text-4xl font-serif italic text-foreground tracking-wide font-black">
              Sprint Complete
            </h2>
            <div className="w-full h-px bg-foreground/10" />
            <div className="flex flex-col gap-2">
              <span className="text-xs font-mono uppercase tracking-widest text-foreground/50">Winner Faction</span>
              <span className="text-3xl font-serif font-bold text-foreground" style={{ color: winner?.color }}>
                {winner?.name || 'No Claims'}
              </span>
              <span className="text-xs font-mono text-foreground/60 tracking-wider">
                Claimed {winner?.count || 0} of {tiles.length} cells
              </span>
            </div>
            <button
              onClick={() => handleStartFreshGame(gridSize)}
              disabled={isResetting}
              className="w-full border border-foreground hover:bg-foreground hover:text-background text-foreground font-mono uppercase tracking-wider py-4 text-xs transition-colors duration-200"
            >
              {isResetting ? 'Setting up next board...' : 'OK'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

