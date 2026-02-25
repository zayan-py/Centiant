import re
import asyncio
import discord
from discord import app_commands
import os
import csv
import json
import subprocess
from dotenv import load_dotenv
import database

load_dotenv()

TOKEN = os.getenv("DISCORD_TOKEN")
KEYS_FILE = "keys.csv"

# Color Palette
COLOR_INVISIBLE = 0x2b2d31 # Modern "invisible" color
COLOR_ERROR = 0xff4d4d
COLOR_SUCCESS = 0x2ecc71
COLOR_PURPLE = 0x9b59b6

class MyBot(discord.Client):
    def __init__(self):
        super().__init__(intents=discord.Intents.default())
        self.tree = app_commands.CommandTree(self)

    async def setup_hook(self):
        await self.tree.sync()

bot = MyBot()

async def run_node_script(script_name, args, env=None):
    """Executes a Node script asynchronously and robustly parses the last JSON line."""
    try:
        if env is None:
            env = os.environ.copy()
            
        process = await asyncio.create_subprocess_exec(
            'node', script_name, *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env
        )
        stdout, stderr = await process.communicate()
        
        stdout_text = stdout.decode('utf-8', errors='ignore').strip()
        stderr_text = stderr.decode('utf-8', errors='ignore').strip()
        
        if process.returncode != 0:
            return {"success": False, "error": f"Script failed (Exit {process.returncode}): {stderr_text}"}
            
        # Robust JSON extraction: look for the last line that looks like JSON
        for line in reversed(stdout_text.splitlines()):
            line = line.strip()
            if line.startswith('{') and line.endswith('}'):
                try:
                    return json.loads(line)
                except:
                    continue
                    
        return {"success": False, "error": "No valid JSON response found in output."}
    except Exception as e:
        return {"success": False, "error": str(e)}

class LoginModal(discord.ui.Modal, title='Century Tech Login'):
    username = discord.ui.TextInput(label='Username', placeholder='Enter your Century username...')
    password = discord.ui.TextInput(label='Password', placeholder='Enter your Century password...', style=discord.TextStyle.short)

    async def on_submit(self, interaction: discord.Interaction):
        embed = discord.Embed(description=f'🔍 Validating credentials for `{self.username.value}`...', color=COLOR_INVISIBLE)
        await interaction.response.send_message(embed=embed, ephemeral=True)
        
        # Run auth_check.js asynchronously
        data = await run_node_script('auth_check.js', [self.username.value, self.password.value])
        
        if data.get('success'):
            database.update_credentials(str(interaction.user.id), self.username.value, self.password.value)
            embed.description = f'✅ Login successful! Account `{self.username.value}` is now locked to your Discord ID.'
            embed.color = COLOR_SUCCESS
            await interaction.edit_original_response(embed=embed)
        else:
            embed.description = f'❌ Login failed: {data.get("error")}'
            embed.color = COLOR_ERROR
            await interaction.edit_original_response(embed=embed)

@bot.tree.command(name="redeem", description="Redeem a 12-digit key to unlock bot access")
async def redeem(interaction: discord.Interaction, key: str):
    user = database.get_user(interaction.user.id)
    if user and user[3]: # is_redeemed
        embed = discord.Embed(description="❌ You have already redeemed a key!", color=COLOR_ERROR)
        await interaction.response.send_message(embed=embed, ephemeral=True)
        return

    # Check keys.csv
    valid = False
    new_keys = []
    if os.path.exists(KEYS_FILE):
        with open(KEYS_FILE, 'r') as f:
            keys = [line.strip() for line in f.readlines()]
            if key in keys:
                valid = True
                keys.remove(key)
                new_keys = keys
            
    if valid:
        # Update keys.csv
        with open(KEYS_FILE, 'w') as f:
            for k in new_keys:
                f.write(f"{k}\n")
        
        database.redeem_user(interaction.user.id)
        embed = discord.Embed(description="✅ Key redeemed! Use `/login` to link your Century account.", color=COLOR_SUCCESS)
        await interaction.response.send_message(embed=embed, ephemeral=True)
    else:
        embed = discord.Embed(description="❌ Invalid or already used key.", color=COLOR_ERROR)
        await interaction.response.send_message(embed=embed, ephemeral=True)

@bot.tree.command(name="login", description="Link your Century Tech account")
async def login(interaction: discord.Interaction):
    user = database.get_user(interaction.user.id)
    if not user or not user[3]: # is_redeemed
        embed = discord.Embed(description="❌ You must redeem a key first using `/redeem`.", color=COLOR_ERROR)
        await interaction.response.send_message(embed=embed, ephemeral=True)
        return
    
    if user[4]: # is_locked
        embed = discord.Embed(description=f"❌ Your account is already locked to `{user[1]}`.", color=COLOR_ERROR)
        await interaction.response.send_message(embed=embed, ephemeral=True)
        return

    await interaction.response.send_modal(LoginModal())

class NuggetSelect(discord.ui.Select):
    def __init__(self, nuggets):
        options = [
            discord.SelectOption(label=n['title'][:100], value=n['url'], description=f"Nugget {i+1}")
            for i, n in enumerate(nuggets[:25])
        ]
        super().__init__(placeholder="Select a nugget to solve...", options=options)

    async def callback(self, interaction: discord.Interaction):
        # Update: When a nugget is selected, start the solver for it
        embed = discord.Embed(description=f"🚀 Initializing High-Speed Solver for: `{self.values[0]}`...", color=COLOR_PURPLE)
        await interaction.response.send_message(embed=embed, ephemeral=True)
        
        user = self.user_creds
        # We start the solver as a separate process
        env = os.environ.copy()
        env["CENTURY_USERNAME"] = user[1]
        env["CENTURY_PASSWORD"] = user[2]
        env["HEADLESS"] = "true"
        env["OPENAI_API_KEY"] = os.getenv("OPENAI_API_KEY")
        
        # Start solving!
        try:
            process = subprocess.Popen(
                ['node', 'century_solver.js', self.values[0]],
                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, 
                text=True, bufsize=1, encoding='utf-8'
            )
            
            # Monitoring loop
            embed = discord.Embed(title="🚀 Solver Running", description="Starting engine...", color=COLOR_INVISIBLE)
            msg = await interaction.followup.send(embed=embed, ephemeral=True)
            
            for line in iter(process.stdout.readline, ''):
                if not line: break
                print(line.strip())
                if "PROGRESS:" in line:
                    token = line.split("PROGRESS:")[1].strip()
                    if "SCORE:" in token:
                        score = token.split("SCORE:")[1]
                        embed.description = f"✅ Nugget Completed!\nAccuracy: **{score}%**"
                        embed.color = COLOR_SUCCESS
                        await msg.edit(embed=embed)
                    elif "NEXT_NUGGET:" in token:
                        remaining = token.split("NEXT_NUGGET:")[1]
                        embed.description = f"⏳ Moving to next nugget... ({remaining} left)"
                        embed.color = COLOR_INVISIBLE
                        await msg.edit(embed=embed)
                elif "SESSION COMPLETE" in line:
                    embed.title = "🏁 Session Finished"
                    embed.description = "The assignment has been completed successfully."
                    embed.color = COLOR_SUCCESS
                    await msg.edit(embed=embed)
                    # Notify via DM
                    try:
                        dm_embed = discord.Embed(title="Assignment Complete", description="✅ Your Century assignment is finished.", color=COLOR_SUCCESS)
                        await interaction.user.send(embed=dm_embed)
                    except: pass
                    break

        except Exception as e:
            embed = discord.Embed(description=f"❌ Error starting solver: {str(e)}", color=COLOR_ERROR)
            await interaction.followup.send(embed=embed, ephemeral=True)

class AssignmentSelect(discord.ui.Select):
    def __init__(self, user_creds, assignments):
        self.user_creds = user_creds
        options = [
            discord.SelectOption(label=a['title'][:100], value=a['url'], description=f"{a['subject']} | {a['count']}")
            for a in assignments[:25]
        ]
        super().__init__(placeholder="Select an assignment to explore...", options=options)

    async def callback(self, interaction: discord.Interaction):
        embed = discord.Embed(description="🔍 Fetching nuggets for this assignment...", color=COLOR_INVISIBLE)
        await interaction.response.edit_message(embed=embed, view=None)
        
        data = await run_node_script('scraper.js', [self.user_creds[1], self.user_creds[2], 'nuggets', self.values[0]])
        
        if data.get('success'):
            nuggets = data.get('nuggets', [])
            if not nuggets:
                embed = discord.Embed(description="❌ No nuggets found in this assignment.", color=COLOR_ERROR)
                await interaction.followup.send(embed=embed, ephemeral=True)
                return
            
            embed = discord.Embed(title="Nuggets Found", color=COLOR_PURPLE)
            nugget_list = "\n".join([f"• {n['title']}" for n in nuggets])
            embed.description = f"Found **{len(nuggets)}** nuggets:\n\n{nugget_list}"
            
            view = discord.ui.View()
            # Added: Start button to solve all nuggets
            class StartButton(discord.ui.Button):
                def __init__(self, user_creds, nuggets):
                    super().__init__(label="🚀 Start Solving All", style=discord.ButtonStyle.success)
                    self.user_creds = user_creds
                    self.nuggets = nuggets

                async def callback(self, interaction: discord.Interaction):
                    embed = discord.Embed(description="🚀 Starting full assignment solver!", color=COLOR_PURPLE)
                    await interaction.response.send_message(embed=embed, ephemeral=True)
                    # Implementation of full solve in Phase 3
            
            view.add_item(StartButton(self.user_creds, nuggets))
            view.add_item(NuggetSelect(nuggets))
            await interaction.followup.send(embed=embed, view=view, ephemeral=True)
        else:
            embed = discord.Embed(description=f"❌ Error: {data.get('error')}", color=COLOR_ERROR)
            await interaction.followup.send(embed=embed, ephemeral=True)

@bot.tree.command(name="solve", description="Browse and solve assignments")
async def solve(interaction: discord.Interaction):
    user = database.get_user(interaction.user.id)
    if not user or not user[4]: # is_locked
        embed = discord.Embed(description="❌ You must search and link your account via `/login` first.", color=COLOR_ERROR)
        await interaction.response.send_message(embed=embed, ephemeral=True)
        return

    embed = discord.Embed(description="🔍 Scanning for due assignments...", color=COLOR_INVISIBLE)
    await interaction.response.send_message(embed=embed, ephemeral=True)
    
    data = await run_node_script('scraper.js', [user[1], user[2], 'assignments'])
    
    if data.get('success'):
        assignments = data.get('assignments', [])
        if not assignments:
            embed = discord.Embed(description="✅ No due assignments found! Great job.", color=COLOR_SUCCESS)
            await interaction.edit_original_response(embed=embed)
            return
        
        view = discord.ui.View()
        view.add_item(AssignmentSelect(user, assignments))
        
        embed = discord.Embed(title="Due Assignments", description=f"Found **{len(assignments)}** assignments.", color=COLOR_PURPLE)
        await interaction.edit_original_response(embed=embed, view=view)
    else:
        embed = discord.Embed(description=f"❌ Error: {data.get('error')}", color=COLOR_ERROR)
        await interaction.edit_original_response(embed=embed)

if __name__ == "__main__":
    database.init_db()
    if not TOKEN:
        print("ERROR: DISCORD_TOKEN not found in .env")
    else:
        bot.run(TOKEN)
